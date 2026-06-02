const { app, BrowserWindow, ipcMain, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { Client } = require("ssh2");
const { helperActionScript } = require("../scripts/remote-actions.cjs");
const { createHostVerifier } = require("../scripts/ssh-trust.cjs");
const { explainDiagnostics } = require("../scripts/ai-explain.cjs");

const isDev = process.env.ELECTRON_DEV === "1";

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

function runSshAdminTest({ host, port, username, password, expectedHostFingerprint }) {
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

    const finish = (patch = {}) => {
      if (settled) return;
      settled = true;
      Object.assign(result, patch);
      conn.end();
      resolve(result);
    };

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

          stream.write(`${password}\n`);
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
        password,
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

function runSshAction({ host, port, username, password, sudoPassword, action, actionPayload, expectedHostFingerprint }) {
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

    const finish = (patch = {}) => {
      if (settled) return;
      settled = true;
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
            stream.write(`${sudoPassword || password}\n`);
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
        password,
        readyTimeout: 15000,
        keepaliveInterval: 5000,
        hostHash: verifier.hostHash,
        hostVerifier: verifier.hostVerifier
      });
  });
}

ipcMain.handle("ssh:test-admin", async (_event, payload) => {
  const host = String(payload?.host || "").trim();
  const port = String(payload?.port || "22").trim();
  const username = String(payload?.username || "").trim();
  const password = String(payload?.password || "");
  const expectedHostFingerprint = String(payload?.hostFingerprint || "").trim();

  if (!host || !username || !password) {
    return {
      ok: false,
      sshOk: false,
      sudoOk: false,
      error: "请填写 VPS IP、长期管理员用户名和密码。"
    };
  }

  return runSshAdminTest({ host, port, username, password, expectedHostFingerprint });
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
  const sudoPassword = String(payload?.sudoPassword || password);
  const action = String(payload?.action || "");
  const expectedHostFingerprint = String(payload?.hostFingerprint || "").trim();

  if (!host || !username || !password || !action) {
    return {
      ok: false,
      stdout: "",
      stderr: "",
      error: "缺少 VPS、账号、密码或部署动作。"
    };
  }

  return runSshAction({
    host,
    port,
    username,
    password,
    sudoPassword,
    action,
    actionPayload: payload,
    expectedHostFingerprint
  });
});
