const { app, BrowserWindow, ipcMain, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Client } = require("ssh2");
const { helperActionScript } = require("../scripts/remote-actions.cjs");
const { createHostVerifier } = require("../scripts/ssh-trust.cjs");
const { explainDiagnostics } = require("../scripts/ai-explain.cjs");
const { buildSshAuth, hasCredential, resolveSudoPassword } = require("../scripts/ssh-auth.cjs");

const isDev = process.env.ELECTRON_DEV === "1";

// 远程命令整体看门狗：连接握手由 readyTimeout 负责，这里防的是命令卡死
// （例如 apt-get 卡在交互提示）导致 keepalive 仍在维持连接、Promise 永不结束。
const REMOTE_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

function createWindow() {
  const entry = isDev
    ? path.join(__dirname, "..", "index.html")
    : path.join(__dirname, "..", "dist", "web", "index.html");
  const allowedEntryUrl = pathToFileURL(entry).toString();

  const mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "自托管 VPS 安全部署助手",
    icon: path.join(__dirname, "..", "assets", "icon.png"),
    backgroundColor: "#f2f2f7",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
      sandbox: true
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== allowedEntryUrl) {
      event.preventDefault();
    }
  });

  mainWindow.loadFile(entry);
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  for (const session of sshSessions.values()) {
    try {
      session.conn.end();
    } catch (_error) {
      /* 退出时尽力关闭，忽略异常 */
    }
  }
  sshSessions.clear();
});

function knownHostsPath() {
  return path.join(app.getPath("userData"), "known_hosts.json");
}

const DEFAULT_AI_BASE_URL = "https://api.deepseek.com";
const DEFAULT_AI_MODEL = "deepseek-chat";

function aiSettingsPath() {
  return path.join(app.getPath("userData"), "ai-settings.json");
}

function loadAiSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(aiSettingsPath(), "utf8"));
    return {
      enabled: Boolean(parsed?.enabled),
      apiKey: typeof parsed?.apiKey === "string" ? parsed.apiKey : "",
      baseUrl: typeof parsed?.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : DEFAULT_AI_BASE_URL,
      model: typeof parsed?.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_AI_MODEL
    };
  } catch (_error) {
    return { enabled: false, apiKey: "", baseUrl: DEFAULT_AI_BASE_URL, model: DEFAULT_AI_MODEL };
  }
}

function saveAiSettings(next) {
  fs.mkdirSync(path.dirname(aiSettingsPath()), { recursive: true });
  fs.writeFileSync(aiSettingsPath(), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

// 只回传是否已配置，绝不把 apiKey 发回渲染层。
function aiStatus(settings = loadAiSettings()) {
  return {
    enabled: settings.enabled,
    hasKey: Boolean(settings.apiKey),
    baseUrl: settings.baseUrl,
    model: settings.model
  };
}

function runSshAdminTest({ host, port, username, password, privateKey, keyPassphrase, sudoPassword, expectedHostFingerprint }) {
  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    const result = {
      ok: false,
      sshOk: false,
      sudoOk: false,
      sudoUser: "",
      hostFingerprint: "",
      system: "",
      error: ""
    };

    const verifier = createHostVerifier({
      knownHostsPath: knownHostsPath(),
      host,
      port,
      expectedFingerprint: expectedHostFingerprint,
      onFingerprint: (fingerprint) => {
        result.hostFingerprint = fingerprint;
      }
    });

    let watchdog = null;
    const finish = (patch = {}) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      Object.assign(result, patch);
      conn.end();
      resolve(result);
    };

    watchdog = setTimeout(() => {
      finish({ error: "SSH 测试超时，远程长时间无响应。" });
    }, REMOTE_EXEC_TIMEOUT_MS);

    conn
      .on("ready", () => {
        result.sshOk = true;
        conn.exec("uname -a && sudo -S -p '' whoami", { pty: false }, (err, stream) => {
          if (err) {
            finish({ error: "SSH 已连接，但无法执行 sudo 测试。" });
            return;
          }

          let stdout = "";
          let stderr = "";
          stream
            .on("error", (streamError) => {
              finish({ error: streamError.message || "SSH 执行通道异常中断。" });
            })
            .on("close", (code) => {
              const lines = stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
              result.system = lines[0] || "";
              result.sudoUser = lines[lines.length - 1] || "";
              result.sudoOk = code === 0 && result.sudoUser === "root";
              finish({
                ok: result.sshOk && result.sudoOk,
                error: result.sudoOk ? "" : stderr || "sudo whoami 未返回 root。"
              });
            })
            .on("data", (data) => {
              stdout += data.toString("utf8");
            })
            .stderr.on("data", (data) => {
              stderr += data.toString("utf8");
            });

          stream.write(`${resolveSudoPassword({ sudoPassword, password })}\n`);
          stream.end();
        });
      })
      .on("error", (error) => {
        finish({ error: verifier.getRejection() || error.message || "SSH 连接失败。" });
      })
      .connect({
        host,
        port: Number(port) || 22,
        username,
        ...buildSshAuth({ password, privateKey, passphrase: keyPassphrase }),
        readyTimeout: 15000,
        keepaliveInterval: 5000,
        hostHash: verifier.hostHash,
        hostVerifier: verifier.hostVerifier
      });
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function generateRealityKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });

  if (!publicJwk.x || !privateJwk.d) {
    throw new Error("当前系统无法导出 X25519 Reality 密钥。");
  }

  return {
    publicKey: publicJwk.x,
    privateKey: privateJwk.d
  };
}

function deploymentActionScript(action, payload) {
  const tempUser = String(payload.tempUser || "appdeploy").trim();
  const tempPassword = String(payload.tempPassword || "");
  const sshPort = Number(payload.sshPort) || 22;
  const servicePort = Number(payload.servicePort) || 443;
  const protocol = safeProtocolName(payload.protocolName);
  const serverConfigJson = String(payload.serverConfigJson || "");

  switch (action) {
    case "create-temporary":
      return `
set -e
TEMP_USER=${shellQuote(tempUser)}
TEMP_PASSWORD=${shellQuote(tempPassword)}
if ! id "$TEMP_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$TEMP_USER"
fi
printf '%s:%s\\n' "$TEMP_USER" "$TEMP_PASSWORD" | chpasswd
usermod -aG sudo "$TEMP_USER"
id "$TEMP_USER"
`;
    case "verify-deploy-user":
      return "whoami && sudo -S -p '' whoami";
    case "system-check":
      return `
set -e
uname -a
if command -v lsb_release >/dev/null 2>&1; then lsb_release -a || true; fi
command -v apt-get >/dev/null 2>&1 && echo apt-get-ready
`;
    case "install-dependencies":
      return `
set -e
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y curl unzip tar ca-certificates ufw
`;
    case "configure-firewall":
      return `
set -e
ufw allow ${sshPort}/tcp
ufw allow ${servicePort}/tcp
ufw --force enable
ufw status verbose
`;
    case "install-proxy-service":
      if (!serverConfigJson) {
        throw new Error("缺少服务端协议配置，无法生成可用订阅链接。");
      }

      return `
set -e
PROTOCOL_NAME=${shellQuote(protocol)}
XRAY_CONFIG_B64=${shellQuote(Buffer.from(serverConfigJson, "utf8").toString("base64"))}
echo "准备部署协议: $PROTOCOL_NAME"
if ! command -v systemctl >/dev/null 2>&1; then
  echo "当前系统不支持 systemctl，无法继续服务部署。" >&2
  exit 1
fi
if ! command -v xray >/dev/null 2>&1; then
  bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
fi
install -d -m 755 /usr/local/etc/xray
printf '%s' "$XRAY_CONFIG_B64" | base64 -d > /usr/local/etc/xray/config.json
systemctl enable xray
systemctl restart xray
systemctl --no-pager --full status xray
echo "协议服务配置已写入并重启，下一步会验证服务端口。"
`;
    case "verify-service":
      return `
set -e
systemctl --no-pager --full status xray
ss -tulpen | grep ":${servicePort}"
echo "服务状态检查完成。"
`;
    default:
      if (helperActionScript(action, payload)) return helperActionScript(action, payload);
      throw new Error("未知部署动作。");
  }
}

function safeProtocolName(value) {
  const protocol = String(value || "VLESS + REALITY + Vision").trim();
  const allowed = new Set([
    "VLESS + REALITY + Vision",
    "Xray-core + VLESS + REALITY + XTLS Vision + uTLS"
  ]);
  if (!allowed.has(protocol)) {
    throw new Error("协议名称不在允许列表内。");
  }
  return protocol;
}

function runSshAction({ host, port, username, password, privateKey, keyPassphrase, sudoPassword, action, actionPayload, expectedHostFingerprint }) {
  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    const result = {
      ok: false,
      stdout: "",
      stderr: "",
      error: "",
      action
    };

    const verifier = createHostVerifier({
      knownHostsPath: knownHostsPath(),
      host,
      port,
      expectedFingerprint: expectedHostFingerprint,
      onFingerprint: (fingerprint) => {
        result.hostFingerprint = fingerprint;
      }
    });

    let watchdog = null;
    const finish = (patch = {}) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      Object.assign(result, patch);
      conn.end();
      resolve(result);
    };

    let script = "";
    try {
      script = deploymentActionScript(action, actionPayload || {});
    } catch (error) {
      resolve({ ...result, error: error.message || "部署动作无效。" });
      return;
    }

    watchdog = setTimeout(() => {
      finish({ error: "部署步骤执行超时，远程命令长时间无响应。" });
    }, REMOTE_EXEC_TIMEOUT_MS);

    conn
      .on("ready", () => {
        const wrapped = action === "system-check"
          ? `bash -lc ${shellQuote(script)}`
          : `sudo -S -p '' bash -lc ${shellQuote(script)}`;

        conn.exec(wrapped, { pty: false }, (err, stream) => {
          if (err) {
            finish({ error: "SSH 已连接，但无法执行当前部署动作。" });
            return;
          }

          stream
            .on("error", (streamError) => {
              finish({ error: streamError.message || "SSH 执行通道异常中断。" });
            })
            .on("close", (code) => {
              finish({
                ok: code === 0,
                error: code === 0 ? "" : result.stderr || "当前步骤执行失败。"
              });
            })
            .on("data", (data) => {
              result.stdout += data.toString("utf8");
            })
            .stderr.on("data", (data) => {
              result.stderr += data.toString("utf8");
            });

          if (action !== "system-check") {
            stream.write(`${resolveSudoPassword({ sudoPassword, password })}\n`);
          }
          stream.end();
        });
      })
      .on("error", (error) => {
        finish({ error: verifier.getRejection() || error.message || "SSH 连接失败。" });
      })
      .connect({
        host,
        port: Number(port) || 22,
        username,
        ...buildSshAuth({ password, privateKey, passphrase: keyPassphrase }),
        readyTimeout: 15000,
        keepaliveInterval: 5000,
        hostHash: verifier.hostHash,
        hostVerifier: verifier.hostVerifier
      });
  });
}

// ── 持久化 SSH 会话：一条连接贯穿整个部署向导，支持流式输出与中断 ──
// sessionId -> { conn, creds, activeStream, cancelled }
const sshSessions = new Map();

function openSshSession({ host, port, username, password, privateKey, keyPassphrase, sudoPassword, expectedHostFingerprint }) {
  return new Promise((resolve) => {
    const conn = new Client();
    let settled = false;
    let hostFingerprint = "";

    const verifier = createHostVerifier({
      knownHostsPath: knownHostsPath(),
      host,
      port,
      expectedFingerprint: expectedHostFingerprint,
      onFingerprint: (fp) => {
        hostFingerprint = fp;
      }
    });

    let watchdog = null;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      if (!res.ok) conn.end();
      resolve(res);
    };

    watchdog = setTimeout(() => finish({ ok: false, error: "SSH 会话连接超时。" }), 20000);

    conn
      .on("ready", () => {
        const sessionId = crypto.randomUUID();
        sshSessions.set(sessionId, {
          conn,
          creds: { password, sudoPassword },
          activeStream: null,
          cancelled: false
        });
        conn.on("close", () => sshSessions.delete(sessionId));
        finish({ ok: true, sessionId, hostFingerprint });
      })
      .on("error", (error) => {
        finish({ ok: false, error: verifier.getRejection() || error.message || "SSH 连接失败。" });
      })
      .connect({
        host,
        port: Number(port) || 22,
        username,
        ...buildSshAuth({ password, privateKey, passphrase: keyPassphrase }),
        readyTimeout: 15000,
        keepaliveInterval: 5000,
        hostHash: verifier.hostHash,
        hostVerifier: verifier.hostVerifier
      });
  });
}

function sendStepChunk(webContents, payload) {
  if (webContents && !webContents.isDestroyed()) {
    webContents.send("ssh:step-output", payload);
  }
}

function runSessionStep({ sessionId, action, actionPayload, webContents }) {
  return new Promise((resolve) => {
    const session = sshSessions.get(sessionId);
    if (!session) {
      resolve({ ok: false, stdout: "", stderr: "", error: "会话不存在或已关闭，请重新连接。", action });
      return;
    }

    let script = "";
    try {
      script = deploymentActionScript(action, actionPayload || {});
    } catch (error) {
      resolve({ ok: false, stdout: "", stderr: "", error: error.message || "部署动作无效。", action });
      return;
    }

    session.cancelled = false;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let watchdog = null;
    const finish = (patch = {}) => {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      session.activeStream = null;
      resolve({ ok: false, stdout, stderr, error: "", action, ...patch });
    };

    watchdog = setTimeout(() => finish({ error: "步骤执行超时，远程命令长时间无响应。" }), REMOTE_EXEC_TIMEOUT_MS);

    const wrapped = action === "system-check"
      ? `bash -lc ${shellQuote(script)}`
      : `sudo -S -p '' bash -lc ${shellQuote(script)}`;

    session.conn.exec(wrapped, { pty: false }, (err, stream) => {
      if (err) {
        finish({ error: "无法在当前会话执行该步骤。" });
        return;
      }
      session.activeStream = stream;
      stream
        .on("error", (streamError) => {
          finish({ error: streamError.message || "SSH 执行通道异常中断。" });
        })
        .on("close", (code) => {
          finish({
            ok: !session.cancelled && code === 0,
            error: session.cancelled
              ? "已取消当前步骤。"
              : code === 0
                ? ""
                : stderr || "当前步骤执行失败。"
          });
        })
        .on("data", (data) => {
          const chunk = data.toString("utf8");
          stdout += chunk;
          sendStepChunk(webContents, { sessionId, action, channel: "stdout", chunk });
        })
        .stderr.on("data", (data) => {
          const chunk = data.toString("utf8");
          stderr += chunk;
          sendStepChunk(webContents, { sessionId, action, channel: "stderr", chunk });
        });

      if (action !== "system-check") {
        stream.write(`${resolveSudoPassword(session.creds)}\n`);
      }
      stream.end();
    });
  });
}

function cancelSessionStep(sessionId) {
  const session = sshSessions.get(sessionId);
  if (!session) return { ok: false };
  session.cancelled = true;
  if (session.activeStream) {
    try {
      session.activeStream.close();
    } catch (_error) {
      /* 流可能已关闭，忽略 */
    }
  }
  return { ok: true };
}

function closeSshSession(sessionId) {
  const session = sshSessions.get(sessionId);
  if (session) {
    try {
      session.conn.end();
    } catch (_error) {
      /* 连接可能已断开，忽略 */
    }
    sshSessions.delete(sessionId);
  }
  return { ok: true };
}

ipcMain.handle("ssh:open-session", async (_event, payload) => {
  const host = String(payload?.host || "").trim();
  const port = String(payload?.port || "22").trim();
  const username = String(payload?.username || "").trim();
  const password = String(payload?.password || "");
  const privateKey = String(payload?.privateKey || "");
  const keyPassphrase = String(payload?.keyPassphrase || "");
  const sudoPassword = String(payload?.sudoPassword || "");
  const expectedHostFingerprint = String(payload?.hostFingerprint || "").trim();

  if (!host || !username || !hasCredential({ password, privateKey })) {
    return { ok: false, error: "缺少 VPS、账号或登录凭据。" };
  }

  return openSshSession({ host, port, username, password, privateKey, keyPassphrase, sudoPassword, expectedHostFingerprint });
});

ipcMain.handle("ssh:run-step", async (event, payload) => {
  const sessionId = String(payload?.sessionId || "");
  const action = String(payload?.action || "");
  if (!sessionId || !action) {
    return { ok: false, stdout: "", stderr: "", error: "缺少会话或部署动作。", action };
  }
  return runSessionStep({ sessionId, action, actionPayload: payload, webContents: event.sender });
});

ipcMain.handle("ssh:cancel-step", async (_event, payload) => cancelSessionStep(String(payload?.sessionId || "")));

ipcMain.handle("ssh:close-session", async (_event, payload) => closeSshSession(String(payload?.sessionId || "")));

ipcMain.handle("ssh:test-admin", async (_event, payload) => {
  const host = String(payload?.host || "").trim();
  const port = String(payload?.port || "22").trim();
  const username = String(payload?.username || "").trim();
  const password = String(payload?.password || "");
  const privateKey = String(payload?.privateKey || "");
  const keyPassphrase = String(payload?.keyPassphrase || "");
  const sudoPassword = String(payload?.sudoPassword || "");
  const expectedHostFingerprint = String(payload?.hostFingerprint || "").trim();

  if (!host || !username || !hasCredential({ password, privateKey })) {
    return {
      ok: false,
      sshOk: false,
      sudoOk: false,
      error: "请填写 VPS IP、长期管理员用户名，以及登录密码或私钥。"
    };
  }

  return runSshAdminTest({ host, port, username, password, privateKey, keyPassphrase, sudoPassword, expectedHostFingerprint });
});

ipcMain.handle("crypto:generate-reality-keys", async () => generateRealityKeys());

ipcMain.handle("ai:get-status", async () => aiStatus());

ipcMain.handle("ai:save-settings", async (_event, payload) => {
  const current = loadAiSettings();
  const incomingKey = typeof payload?.apiKey === "string" ? payload.apiKey.trim() : null;
  const next = {
    enabled: Boolean(payload?.enabled),
    // 留空表示沿用已存 key，避免设置界面回显明文 key。
    apiKey: incomingKey === null || incomingKey === "" ? current.apiKey : incomingKey,
    baseUrl: typeof payload?.baseUrl === "string" && payload.baseUrl.trim() ? payload.baseUrl.trim() : current.baseUrl,
    model: typeof payload?.model === "string" && payload.model.trim() ? payload.model.trim() : current.model
  };
  saveAiSettings(next);
  return aiStatus(next);
});

ipcMain.handle("ai:explain-diagnostics", async (_event, payload) => {
  const settings = loadAiSettings();
  if (!settings.enabled) {
    return { ok: false, reason: "disabled", error: "AI 解读未启用。" };
  }
  if (!settings.apiKey) {
    return { ok: false, reason: "no-key", error: "尚未配置 AI 接口密钥。" };
  }
  const kind = String(payload?.kind || "").trim();
  const text = String(payload?.text || "");
  return explainDiagnostics({
    apiKey: settings.apiKey,
    baseUrl: settings.baseUrl,
    model: settings.model,
    kind,
    text
  });
});

ipcMain.handle("ssh:run-deployment-action", async (_event, payload) => {
  const host = String(payload?.host || "").trim();
  const port = String(payload?.port || "22").trim();
  const username = String(payload?.username || "").trim();
  const password = String(payload?.password || "");
  const privateKey = String(payload?.privateKey || "");
  const keyPassphrase = String(payload?.keyPassphrase || "");
  const sudoPassword = String(payload?.sudoPassword || "");
  const action = String(payload?.action || "");
  const expectedHostFingerprint = String(payload?.hostFingerprint || "").trim();

  if (!host || !username || !hasCredential({ password, privateKey }) || !action) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: "缺少 VPS、账号、登录凭据或部署动作。"
    };
  }

  return runSshAction({
    host,
    port,
    username,
    password,
    privateKey,
    keyPassphrase,
    sudoPassword,
    action,
    actionPayload: payload,
    expectedHostFingerprint
  });
});
