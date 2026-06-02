const protocols = {
  vless: {
    name: "VLESS + REALITY + Vision",
    summary: "默认推荐。安全、抗识别和稳定优先，适合大多数自托管 VPS。",
    port: "443"
  },
  hysteria2: {
    name: "Hysteria2",
    summary: "移动网络和速度优先时推荐。需要 UDP 可用，适合高丢包环境。",
    port: "8443"
  },
  tuic: {
    name: "TUIC v5",
    summary: "UDP 可用且低延迟优先时推荐。适合对响应速度敏感的场景。",
    port: "443"
  }
};

const clientTargets = {
  singbox: "sing-box",
  mihomo: "Mihomo / Clash Meta",
  surge: "Surge / Stash",
  links: "Shadowrocket / v2rayN"
};

const state = {
  mode: "standard",
  protocol: "vless",
  deployIdentity: "admin",
  reveal: false,
  outputs: {},
  currentTab: "script",
  secrets: null,
  adminVerified: false,
  adminVerification: null,
  deploymentStepIndex: 0,
  deploymentCompleted: false,
  deploymentRunning: false,
  claudeRaw: "",
  claudeSummary: "",
  bbrRaw: "",
  bbrSummary: "",
  autofixRaw: "",
  autofixSummary: "",
  stepResults: {},
  deploymentOutcome: "idle"
};

const el = (id) => document.getElementById(id);
const els = (selector) => Array.from(document.querySelectorAll(selector));

const sensitivePatterns = [
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP已隐藏]"],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "[UUID已隐藏]"],
  [/(privateKey|password|passwd|pwd|uuid|shortId|server|address|host|sni)(\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,\n]+)/gi, "$1$2[已隐藏]"],
  [/vless:\/\/[^\s"']+/gi, "[订阅链接已隐藏]"],
  [/(?<![\/\w-])(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cn|top|xyz|cloud|co|me|info|biz|site|online|link)(?![\w-])/gi, (match) => {
    const safeInfrastructureDomains = [
      "www.cloudflare.com",
      "github.com",
      "raw.githubusercontent.com",
      "claude.ai",
      "anthropic.com",
      "api.anthropic.com",
      "console.anthropic.com",
      "statsig.anthropic.com",
      "intercom.io",
      "intercomcdn.com",
      "statsig.com",
      "sentry.io",
      "ipinfo.io"
    ];
    if (safeInfrastructureDomains.includes(match.toLowerCase())) return match;
    return "[域名已隐藏]";
  }]
];

function redact(text) {
  return sensitivePatterns.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), String(text));
}

function display(text) {
  return state.reveal ? text : redact(text);
}

function log(message) {
  const row = document.createElement("div");
  row.className = "log-item";
  row.textContent = `${new Date().toLocaleTimeString()} ${redact(message)}`;
  el("logView").prepend(row);
}

function bytesToBase64Url(bytes) {
  const bin = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToBase64(bytes) {
  const bin = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(bin);
}

function base64Utf8(value) {
  return bytesToBase64(new TextEncoder().encode(String(value)));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function randomHex(bytes = 8) {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function generateRealityKeys() {
  if (window.vpsDesktop?.generateRealityKeys) {
    return window.vpsDesktop.generateRealityKeys();
  }

  if (!crypto.subtle) {
    throw new Error("当前浏览器不支持 Web Crypto，无法本地生成 X25519 密钥。");
  }

  const keyPair = await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);

  if (!privateJwk.d) {
    throw new Error("当前浏览器无法导出 X25519 私钥。");
  }

  return {
    publicKey: bytesToBase64Url(publicRaw),
    privateKey: privateJwk.d
  };
}

async function ensureSecrets() {
  if (state.secrets) return state.secrets;

  const reality = await generateRealityKeys();
  state.secrets = {
    uuid: crypto.randomUUID(),
    shortId: randomHex(8),
    ...reality
  };
  return state.secrets;
}

function values() {
  return {
    ip: el("vpsIp").value.trim(),
    sshPort: el("sshPort").value.trim() || "22",
    adminUser: el("adminUser").value.trim() || "myadmin",
    servicePort: el("servicePort").value.trim() || protocols[state.protocol].port,
    serverName: el("serverName").value.trim() || "www.cloudflare.com",
    hostFingerprint: el("hostFingerprint").value.trim()
  };
}

function validInputs() {
  const v = values();
  return Boolean(state.adminVerified && state.deploymentCompleted && v.ip && v.sshPort && v.servicePort && selectedClients().length);
}

function updateGenerateState() {
  el("generateAll").disabled = !validInputs();
  updateDeployRunnerState();
}

function setStep(index) {
  els(".steps li").forEach((item, i) => item.classList.toggle("active", i === index));
}

function selectedClients() {
  return els(".client-target")
    .filter((box) => box.checked)
    .map((box) => box.value);
}

function clientSelectionText() {
  const selected = selectedClients();
  if (!selected.length) return "未选择客户端配置";
  return selected.map((key) => clientTargets[key]).join("、");
}

function syncClientSelectAll() {
  const boxes = els(".client-target");
  el("selectAllClients").checked = boxes.every((box) => box.checked);
}

function deploySteps() {
  return [
    { id: "verify-deploy-user", title: "验证长期管理员权限", hint: "确认当前长期管理员账号可以执行 sudo。" },
    { id: "system-check", title: "检查系统环境", hint: "检查系统版本、CPU 架构和基础包管理器。" },
    { id: "install-dependencies", title: "安装必要依赖", hint: "安装 curl、unzip、tar、ca-certificates、ufw 等组件。" },
    { id: "enable-bbr-soft", title: "检测并开启 BBR", hint: "尝试启用 BBR；如果系统不支持，会在结束后告诉你原因。" },
    { id: "configure-firewall", title: "配置防火墙", hint: "只开放 SSH 端口和代理服务端口，不关闭防火墙。" },
    { id: "install-proxy-service", title: `部署 ${protocols[state.protocol].name}`, hint: "按固定安全协议安装并配置服务端。" },
    { id: "verify-service", title: "测试服务状态", hint: "确认代理服务已启动，服务端口可监听。" },
    { id: "claude-test", title: "检测 Claude 连通性", hint: "自动检测出口、DNS、IPv6 与 Claude 相关域名是否可连通。" },
    { id: "autofix-all", title: "自动自愈修复", hint: "检测到异常时自动尝试修复，并在结束后告诉你仍未完成的部分。" }
  ];
}

function renderDeploySteps() {
  const list = el("deployStepList");
  list.innerHTML = "";
  deploySteps().forEach((step, index) => {
    const item = document.createElement("li");
    const result = state.stepResults[step.id];
    if (result?.status === "success") item.className = "done";
    else if (result?.status === "warning") item.className = "warning";
    else if (result?.status === "failed") item.className = "failed";
    else if (index === state.deploymentStepIndex && state.deploymentRunning) item.className = "running";
    else if (index === state.deploymentStepIndex && !state.deploymentRunning && !state.deploymentCompleted) item.className = "active";

    const icon = result?.status === "success"
      ? "✅"
      : result?.status === "warning"
        ? "⚠️"
        : result?.status === "failed"
          ? "❌"
          : "";
    item.textContent = icon ? `${icon} ${step.title}` : step.title;
    list.append(item);
  });
}

function resetDeployFlow(shouldLog = true) {
  state.deploymentStepIndex = 0;
  state.deploymentCompleted = false;
  state.deploymentRunning = false;
  state.stepResults = {};
  state.deploymentOutcome = "idle";
  el("deployRunStatus").classList.remove("success", "danger", "warning");
  el("deployRunStatus").classList.add("pending");
  el("deployRunStatus").textContent = "未开始";
  el("deployCurrentTitle").textContent = "等待开始";
  el("deployCurrentHint").textContent = "完成 SSH 验证后，点击开始部署。";
  renderDeploySteps();
  updateGenerateState();
  if (shouldLog) log("部署执行向导已重置。");
}

function deployPrerequisitesReady() {
  const v = values();
  return Boolean(state.adminVerified && v.ip && v.sshPort);
}

function updateDeployRunnerState() {
  if (!el("runDeployStep")) return;
  el("runDeployStep").disabled = state.deploymentRunning || state.deploymentCompleted || !deployPrerequisitesReady();
  if (state.deploymentCompleted) {
    el("runDeployStep").textContent = "自动部署已完成";
  } else if (state.deploymentRunning) {
    el("runDeployStep").textContent = "正在自动部署，请等待...";
  } else {
    el("runDeployStep").textContent = "开始自动部署";
  }
  renderDeploySteps();
}

function showResultModal(title, text) {
  el("resultModalTitle").textContent = title;
  el("resultModalBody").value = display(text || "没有可显示的内容。");
  el("resultModal").classList.remove("hidden");
}

function hideResultModal() {
  el("resultModal").classList.add("hidden");
}

function classifyStepResult(stepId, stdout) {
  if (stepId === "enable-bbr-soft") {
    return /未确认开启|未开启/.test(state.bbrSummary) ? "warning" : "success";
  }
  if (stepId === "claude-test") {
    return /存在连接异常/.test(state.claudeSummary) ? "warning" : "success";
  }
  if (stepId === "autofix-all") {
    return /部分修复|遗留告警|修复失败/.test(state.autofixSummary) ? "warning" : "success";
  }
  return stdout && /failed|error|未监听|未开放/i.test(stdout) ? "warning" : "success";
}

function incompleteStepMessages() {
  return deploySteps()
    .map((step) => ({ step, result: state.stepResults[step.id] }))
    .filter(({ result }) => result && result.status !== "success")
    .map(({ step, result }) => `${result.status === "failed" ? "❌" : "⚠️"} ${step.title}\n${result.reason || "需要进一步检查。"}`);
}

function deployCredentialsFor(stepId) {
  const v = values();
  const adminPassword = el("adminPassword").value;
  return {
    username: v.adminUser,
    password: adminPassword,
    sudoPassword: adminPassword
  };
}

async function runSingleDeployStep(step, steps) {
  const v = values();
  const creds = deployCredentialsFor(step.id);
  const payload = {
    action: step.id,
    host: v.ip,
    port: v.sshPort,
    sshPort: v.sshPort,
    servicePort: v.servicePort,
    protocolKey: state.protocol,
    protocolName: protocols[state.protocol].name,
    username: creds.username,
    password: creds.password,
    sudoPassword: creds.sudoPassword,
    hostFingerprint: v.hostFingerprint,
    serverName: v.serverName,
    force: false
  };

  if (step.id === "install-proxy-service" || step.id === "autofix-all") {
    const secrets = await ensureSecrets();
    payload.serverConfigJson = JSON.stringify(xrayServerConfig(v, secrets), null, 2);
  }

  el("deployRunStatus").classList.remove("success", "danger");
  el("deployRunStatus").classList.add("pending");
  el("deployRunStatus").textContent = "执行中";
  el("deployCurrentTitle").textContent = step.title;
  el("deployCurrentHint").textContent = step.hint || "正在安装或配置，请等待。不要关闭应用。";
  updateDeployRunnerState();

  const result = await window.vpsDesktop.runDeploymentAction(payload);

  if (!result.ok) {
    state.stepResults[step.id] = {
      status: "failed",
      reason: result.error || result.stderr || "当前步骤执行失败。"
    };
    state.deploymentOutcome = "failed";
    el("deployRunStatus").classList.remove("pending");
    el("deployRunStatus").classList.add("danger");
    el("deployRunStatus").textContent = "❌ 未完成";
    showResultModal(`未完成：${step.title}`, state.stepResults[step.id].reason);
    log(`${step.title} 执行失败：${result.error || "未知错误"}。`);
    renderDeploySteps();
    return false;
  }

  if (step.id === "enable-bbr-soft") {
    state.bbrRaw = result.stdout || "";
    state.bbrSummary = bbrSummaryText(result.stdout || "");
  }

  if (step.id === "claude-test") {
    state.claudeRaw = result.stdout || "";
    state.claudeSummary = claudeSummaryText(result.stdout || "");
  }

  if (step.id === "autofix-all") {
    state.autofixRaw = result.stdout || "";
    state.autofixSummary = autofixSummaryText(result.stdout || "");
  }

  const stepSummary = deploymentStepSummary(step.id, result.stdout || "") || "当前步骤已完成。";
  const stepStatus = classifyStepResult(step.id, result.stdout || "");
  state.stepResults[step.id] = {
    status: stepStatus,
    reason: stepSummary
  };
  if (stepStatus === "warning" && state.deploymentOutcome !== "failed") {
    state.deploymentOutcome = "warning";
  }

  state.deploymentStepIndex += 1;
  if (state.deploymentStepIndex >= steps.length) {
    state.deploymentCompleted = true;
    el("deployRunStatus").classList.remove("pending", "danger", "success", "warning");
    const incomplete = incompleteStepMessages();
    if (state.deploymentOutcome === "failed") {
      el("deployRunStatus").classList.add("danger");
      el("deployRunStatus").textContent = "❌ 未完成";
    } else if (incomplete.length) {
      state.deploymentOutcome = "warning";
      el("deployRunStatus").classList.add("warning");
      el("deployRunStatus").textContent = "⚠️ 部署完成但未跑通";
      showResultModal("部署完成但仍有未跑通部分", incomplete.join("\n\n"));
    } else {
      state.deploymentOutcome = "success";
      el("deployRunStatus").classList.add("success");
      el("deployRunStatus").textContent = "✅ 已完成";
    }
    el("deployCurrentTitle").textContent = "部署结果";
    el("deployCurrentHint").textContent = state.deploymentOutcome === "success"
      ? "所有部署步骤都已完成，现在可以生成客户端配置与订阅链接。"
      : "部署流程已结束，请根据弹窗提示处理未完成的部分。";
  }
  log(`${step.title} 已完成。`);
  updateDeployRunnerState();
  return true;
}

async function runDeployStep() {
  const desktopApi = window.vpsDesktop;
  if (!desktopApi?.runDeploymentAction) {
    showResultModal("无法开始自动部署", "当前是 Web 预览版，不能直接执行远程部署。请使用桌面版。");
    log("当前环境不支持远程部署执行，请使用 Electron 桌面版。");
    return;
  }

  if (!deployPrerequisitesReady()) {
    showResultModal("还不能开始部署", "请先完成 SSH 验证。");
    return;
  }

  const steps = deploySteps();
  state.deploymentRunning = true;
  el("deployRunStatus").textContent = "自动部署中";
  el("deployCurrentHint").textContent = "正在按顺序执行部署步骤，请等待。";
  updateDeployRunnerState();

  try {
    while (state.deploymentStepIndex < steps.length) {
      const step = steps[state.deploymentStepIndex];
      const ok = await runSingleDeployStep(step, steps);
      if (!ok) break;
    }
  } catch (error) {
    el("deployRunStatus").classList.remove("pending");
    el("deployRunStatus").classList.add("danger");
    el("deployRunStatus").textContent = "❌ 未完成";
    showResultModal("自动部署失败", error.message || "当前步骤执行失败。");
    log(`自动部署执行失败：${error.message || "未知错误"}。`);
  } finally {
    state.deploymentRunning = false;
  }

  updateGenerateState();
}

function setAdminVerification(status, message) {
  const statusEl = el("adminVerifyStatus");
  statusEl.classList.remove("pending", "success", "danger");
  statusEl.classList.add(status);
  statusEl.textContent = status === "success" ? "已验证" : status === "danger" ? "验证失败" : "未验证";
  el("adminVerifyHint").textContent = message;
  updateGenerateState();
}

function resetAdminVerification() {
  state.adminVerified = false;
  state.adminVerification = null;
  setAdminVerification("pending", "长期账号信息已变化，请重新测试 SSH 登录和 sudo。");
}

async function testAdminSsh() {
  const desktopApi = window.vpsDesktop;
  if (!desktopApi?.testAdminSsh) {
    state.adminVerified = false;
    setAdminVerification("danger", "当前是 Web 预览版，不能直接发起 SSH 连接。请使用桌面版进行自动验证。");
    log("当前环境不支持本地 SSH 自动验证，请使用 Electron 桌面版。");
    return;
  }

  const v = values();
  const password = el("adminPassword").value;
  const button = el("testAdminSsh");
  button.disabled = true;
  button.textContent = "正在测试...";
  setAdminVerification("pending", "正在本机连接 VPS，并执行固定测试命令：sudo whoami。");
  log("开始本地 SSH 验证长期管理员账号。");

  try {
    const result = await desktopApi.testAdminSsh({
      host: v.ip,
      port: v.sshPort,
      username: v.adminUser,
      password,
      hostFingerprint: v.hostFingerprint
    });

    state.adminVerification = result;
    state.adminVerified = Boolean(result.ok);

    if (result.hostFingerprint) {
      el("hostFingerprint").value = result.hostFingerprint;
    }

    if (result.ok) {
      setAdminVerification("success", `SSH 登录成功，sudo whoami 输出 root。Host key: ${result.hostFingerprint || "未返回"}`);
      log(`长期管理员账号验证通过：SSH 可连接，sudo 输出 ${result.sudoUser || "root"}。`);
    } else {
      setAdminVerification("danger", result.error || "SSH 或 sudo 验证失败，请检查长期管理员账号。");
      log(`长期管理员账号验证失败：${result.error || "未知错误"}。`);
    }
  } catch (error) {
    state.adminVerified = false;
    setAdminVerification("danger", error.message || "SSH 验证失败。");
    log(`长期管理员账号验证失败：${error.message || "未知错误"}。`);
  } finally {
    button.disabled = false;
    button.textContent = "测试长期账号 SSH 和 sudo";
  }
}

function deploymentScript(v, secrets) {
  const protocolName = protocols[state.protocol].name;
  const xrayConfig = JSON.stringify(xrayServerConfig(v, secrets), null, 2);
  const xrayConfigB64 = base64Utf8(xrayConfig);

  return `#!/usr/bin/env bash
set -Eeuo pipefail

DEPLOY_USER=${shellQuote(v.adminUser)}
SSH_PORT=${shellQuote(v.sshPort)}
SERVICE_PORT=${shellQuote(v.servicePort)}
PROTOCOL=${shellQuote(protocolName)}
XRAY_CONFIG_B64=${shellQuote(xrayConfigB64)}
DEPLOY_IDENTITY="admin"

echo "[1/8] 检查系统版本、CPU 架构、网络和端口"
uname -a
if command -v lsb_release >/dev/null 2>&1; then lsb_release -a || true; fi
ss -tulpen | sed 's/users:.*//g' || true

echo "[2/8] 更新系统包并安装必要依赖"
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y curl unzip tar ca-certificates ufw

echo "[3/8] 配置防火墙，只开放 SSH 端口和代理服务端口"
sudo ufw allow "\${SSH_PORT}/tcp"
sudo ufw allow "\${SERVICE_PORT}/tcp"
sudo ufw --force enable
sudo ufw status verbose

echo "[4/8] 安装 Xray Core"
bash -c "$(curl -L https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install

echo "[5/8] 写入 $PROTOCOL 服务配置"
sudo install -d -m 755 /usr/local/etc/xray
printf '%s' "$XRAY_CONFIG_B64" | base64 -d | sudo tee /usr/local/etc/xray/config.json >/dev/null

echo "[6/8] 启动服务并测试状态"
sudo systemctl enable xray
sudo systemctl restart xray
sudo systemctl --no-pager --full status xray
sudo ss -tulpen | grep ":\${SERVICE_PORT}" || (echo "服务端口未监听" >&2; exit 1)

echo "[7/8] 确认 SSH 端口仍开放"
sudo ufw status | grep "\${SSH_PORT}/tcp" || (echo "SSH 端口未开放，停止删除临时账号" >&2; exit 1)

echo "[8/8] 完成部署"
echo "部署完成。以后请继续使用长期管理员账号 ${v.adminUser} 管理 VPS。"
`;
}

function xrayServerConfig(v, secrets) {
  return {
    log: { loglevel: "warning" },
    inbounds: [
      {
        tag: "vless-reality",
        listen: "0.0.0.0",
        port: Number(v.servicePort),
        protocol: "vless",
        settings: {
          clients: [
            {
              id: secrets.uuid,
              flow: "xtls-rprx-vision",
              email: "local-device"
            }
          ],
          decryption: "none"
        },
        streamSettings: {
          network: "tcp",
          security: "reality",
          realitySettings: {
            show: false,
            dest: `${v.serverName}:443`,
            xver: 0,
            serverNames: [v.serverName],
            privateKey: secrets.privateKey,
            shortIds: [secrets.shortId]
          }
        },
        sniffing: {
          enabled: true,
          destOverride: ["http", "tls", "quic"]
        }
      }
    ],
    outbounds: [{ protocol: "freedom", tag: "direct" }]
  };
}

function singBoxConfig(v, secrets) {
  return JSON.stringify(
    {
      log: { level: "warn" },
      inbounds: [
        {
          type: "mixed",
          tag: "mixed-in",
          listen: "127.0.0.1",
          listen_port: 2080
        }
      ],
      outbounds: [
        {
          type: "vless",
          tag: "self-hosted-vless-reality",
          server: v.ip,
          server_port: Number(v.servicePort),
          uuid: secrets.uuid,
          flow: "xtls-rprx-vision",
          tls: {
            enabled: true,
            server_name: v.serverName,
            reality: {
              enabled: true,
              public_key: secrets.publicKey,
              short_id: secrets.shortId
            },
            utls: {
              enabled: true,
              fingerprint: "chrome"
            }
          }
        }
      ]
    },
    null,
    2
  );
}

function mihomoConfig(v, secrets) {
  return `proxies:
  - name: self-hosted-vless-reality
    type: vless
    server: ${v.ip}
    port: ${v.servicePort}
    uuid: ${secrets.uuid}
    network: tcp
    udp: true
    tls: true
    flow: xtls-rprx-vision
    servername: ${v.serverName}
    reality-opts:
      public-key: ${secrets.publicKey}
      short-id: ${secrets.shortId}
    client-fingerprint: chrome

proxy-groups:
  - name: Secure
    type: select
    proxies:
      - self-hosted-vless-reality

rules:
  - MATCH,Secure
`;
}

function linksConfig(v, secrets) {
  const params = new URLSearchParams({
    encryption: "none",
    flow: "xtls-rprx-vision",
    security: "reality",
    sni: v.serverName,
    fp: "chrome",
    pbk: secrets.publicKey,
    sid: secrets.shortId,
    type: "tcp"
  });
  const link = `vless://${secrets.uuid}@${v.ip}:${v.servicePort}?${params.toString()}#self-hosted-vless-reality`;
  return `Shadowrocket / v2rayN / 通用 VLESS 链接
${link}

二维码可在本地二维码工具中由以上链接生成；不要使用第三方在线订阅转换服务。`;
}

function surgeConfig(v, secrets) {
  return `#!MANAGED-CONFIG https://local-only.invalid/self-hosted

[Proxy]
self-hosted-vless-reality = vless, ${v.ip}, ${v.servicePort}, username=${secrets.uuid}, tls=true, flow=xtls-rprx-vision, reality=true, reality-public-key=${secrets.publicKey}, reality-short-id=${secrets.shortId}, sni=${v.serverName}, client-fingerprint=chrome

[Proxy Group]
Secure = select, self-hosted-vless-reality

[Rule]
FINAL,Secure
`;
}

function report(v) {
  const clients = clientSelectionText();
  const claudeRules = claudeProxyRules();
  return `本地安全检查报告

服务状态: 部署脚本包含 systemctl enable/restart/status xray 检查
开放端口: SSH ${v.sshPort}/tcp，代理 ${v.servicePort}/tcp
防火墙状态: ufw 启用，只开放 SSH 和代理服务端口；不提供一键关闭防火墙
协议类型: ${protocols[state.protocol].name}
客户端配置生成状态: ${clients} 已在本地生成
长期管理员验证状态: ${state.adminVerified ? "已通过 SSH 登录和 sudo 测试" : "未通过"}
部署身份策略: 直接使用长期管理员账号 ${v.adminUser} 部署
AI 辅助状态: 未启用
Host key 指纹: ${v.hostFingerprint || "用户尚未填写"}
BBR 状态: ${state.bbrSummary || "未在部署步骤中检测"}
Claude 连通性: ${state.claudeSummary || "未在部署步骤中检测"}
Auto-Fix 状态: ${state.autofixSummary || "未执行自动修复"}
Auto-Fix 报告: /root/vps-helper-autofix-report.md 与 ~/Obsidian/VPS/VPS 配置.md
隐私状态: 不收集、不上传、不保存 VPS IP、SSH 密码、私钥、节点配置或订阅链接
日志脱敏: 已隐藏 IP、密码、UUID、私钥、订阅链接和可识别域名

Claude 分流规则建议:
${claudeRules}

完成提示:
部署完成。请继续使用长期管理员账号 ${v.adminUser} 管理 VPS。
`;
}

function claudeProxyRules() {
  const domains = [
    "claude.ai",
    "anthropic.com",
    "statsigapi.net",
    "intercom.io",
    "intercomcdn.com",
    "statsig.com",
    "sentry.io"
  ];
  const rules = domains.map((domain) => `DOMAIN-SUFFIX,${domain},PROXY`).join("\n");
  return `Clash / Mihomo:
ipv6: false
rules:
${domains.map((domain) => `  - DOMAIN-SUFFIX,${domain},PROXY`).join("\n")}

Surge / Shadowrocket:
${rules}`;
}

function textSection(text, begin, end) {
  const match = String(text).match(new RegExp(`${begin}\\n([\\s\\S]*?)\\n${end}`));
  return match ? match[1].trim() : "";
}

function jsonSection(text, begin, end) {
  try {
    return JSON.parse(textSection(text, begin, end));
  } catch (_error) {
    return {};
  }
}

function traceFields(raw) {
  return Object.fromEntries(
    String(raw)
      .split(/\r?\n/)
      .map((line) => line.split("="))
      .filter((parts) => parts.length >= 2)
      .map(([key, ...value]) => [key, value.join("=")])
  );
}

function claudeDomainRows(raw) {
  return Array.from(String(raw).matchAll(/DOMAIN_BEGIN ([^\n]+)\n([\s\S]*?)DOMAIN_END \1/g)).map((match) => {
    const domain = match[1];
    const body = match[2];
    const pick = (key) => body.match(new RegExp(`^${key} (.*)$`, "m"))?.[1]?.trim() || "未返回";
    const curl = pick("CURL");
    const status = curl.split("|")[0] || "未返回";
    const curlHint = /reset/i.test(curl) ? "connection reset" : /timed? out|timeout/i.test(curl) ? "timeout" : pick("BLOCK_HINT");
    return {
      domain,
      dns: [pick("DNS_V4"), pick("DNS_V6")].filter((value) => value && value !== "未返回").join(" / ") || "失败",
      tcp: pick("TCP443"),
      tls: pick("TLS"),
      http2: pick("HTTP2"),
      status,
      hint: curlHint === "none" ? "无明显拦截词" : curlHint
    };
  });
}

function dnsRegionRows(raw) {
  return Array.from(String(raw).matchAll(/DNS_IPINFO_BEGIN ([^\n]+)\n([\s\S]*?)\nDNS_IPINFO_END \1/g)).map((match) => {
    try {
      const info = JSON.parse(match[2]);
      return `${match[1]} ${info.country || "未知"} ${info.org || info.asn || "未知 ASN"}`;
    } catch (_error) {
      return `${match[1]} 地区未知`;
    }
  });
}

function claudeRiskJudgement(v4, v6, dnsRows, rows) {
  const failedClaude = rows.filter((row) => row.tcp !== "ok" || row.tls !== "ok" || /^000$/.test(row.status));
  const blockedHint = rows.some((row) => /blocked|unsupported|forbidden|denied/i.test(row.hint));
  const dnsMismatch = dnsRows.some((row) => v4.country && !row.includes(` ${v4.country} `));
  const chinaDns = dnsRows.some((row) => /\bCN\b|China/i.test(row));
  const ideas = [];

  if (v6.ip) ideas.push("IPv6 出口可用；若客户端 IPv6 未进入代理，存在 IPv6 泄露可能。");
  if (chinaDns || dnsMismatch) ideas.push("DNS resolver 地区与出口观察不一致，先排查 DNS 是否随代理转发。");
  if (blockedHint) ideas.push("返回内容出现 blocked/unsupported/forbidden 类提示，可能是 Anthropic 对地区、出口 IP 或 ASN 的限制。");
  if (failedClaude.length) ideas.push("Claude 域名链路有 TCP/TLS/curl 失败，可能存在域名未全走代理、链路 reset 或 TLS/HTTP2 指纹异常。");
  if (!ideas.length) ideas.push("VPS 侧基础链路未见明显阻断；若 ChatGPT 可用但 Claude 仍失败，优先怀疑 Anthropic 对当前家宽出口 IP / ASN 风控。");
  return ideas;
}

function claudeSummaryText(raw) {
  const v4 = jsonSection(raw, "IPV4_INFO_BEGIN", "IPV4_INFO_END");
  const v6 = jsonSection(raw, "IPV6_INFO_BEGIN", "IPV6_INFO_END");
  const dnsRows = dnsRegionRows(raw);
  const rows = claudeDomainRows(raw);
  const judgement = claudeRiskJudgement(v4, v6, dnsRows, rows);
  const okCount = rows.filter((row) => row.tcp === "ok" && row.tls === "ok" && !/^000$/.test(row.status)).length;
  const headline = rows.length && okCount === rows.length ? "可以成功连接，链路基础测试通过。" : "存在连接异常，需要继续排查。";
  return `${headline} 出口 ${v4.country || "未知地区"} ${v4.org || "未知 ASN"}。${v6.ip ? " 检测到 IPv6 出口，存在泄露风险。" : ""} 原因推测：${judgement.join("；")}`;
}

function bbrSummaryText(raw) {
  const qdisc = String(raw).match(/^QDISC (.*)$/m)?.[1] || "未返回";
  const congestion = String(raw).match(/^CONGESTION (.*)$/m)?.[1] || "未返回";
  const enabled = /default_qdisc\s*=\s*fq/.test(qdisc) && /tcp_congestion_control\s*=\s*bbr/.test(congestion);
  return enabled
    ? "已开启，拥塞控制算法为 bbr，default_qdisc 为 fq。"
    : `未确认开启。当前 qdisc: ${qdisc}；当前拥塞控制: ${congestion}。可能原因：内核版本过低、系统不支持 BBR、权限不足或 sysctl 未生效。`;
}

function extractAutofixReport(raw) {
  return textSection(raw, "AUTOFIX_REPORT_BEGIN", "AUTOFIX_REPORT_END");
}

function extractAutofixLines(raw, prefix) {
  return Array.from(String(raw).matchAll(new RegExp(`^${prefix} (.*)$`, "gm"))).map((match) => match[1].trim());
}

function autofixSummaryText(raw) {
  const status = String(raw).match(/^AUTOFIX_STATUS (.*)$/m)?.[1]?.trim() || "unknown";
  const target = String(raw).match(/^AUTOFIX_TARGET (.*)$/m)?.[1]?.trim() || "all";
  const issues = extractAutofixLines(raw, "AUTOFIX_ISSUE");
  const actions = extractAutofixLines(raw, "AUTOFIX_ACTION");
  const remaining = extractAutofixLines(raw, "AUTOFIX_REMAINING");
  const statusText = status === "success" ? "修复完成" : status === "partial" ? "部分修复完成" : "修复失败";
  const issueText = issues.length ? `发现 ${issues.length} 项异常` : "未发现明显异常";
  const actionText = actions.length ? `已执行 ${actions.length} 个修复动作` : "未执行配置修改";
  const remainingText = remaining.length ? `仍需关注：${remaining.join("；")}` : "当前没有遗留告警";
  return `目标 ${target}：${statusText}，${issueText}，${actionText}。${remainingText}`;
}

function renderOutput() {
  const content = state.outputs[state.currentTab] || "请先生成内容。";
  const titles = {
    script: "部署脚本",
    singbox: "sing-box 配置",
    mihomo: "Mihomo/Clash Meta 配置",
    surge: "Surge / Stash 配置",
    links: "Shadowrocket / v2rayN 链接",
    autofix: "Auto-Fix 自愈报告",
    report: "安全报告"
  };
  el("outputTitle").textContent = titles[state.currentTab];
  el("outputCode").textContent = display(content);
  el("copyOutput").disabled = !state.outputs[state.currentTab];
}

function deploymentStepSummary(stepId, stdout) {
  if (stepId === "enable-bbr-soft") {
    return `BBR 检测结果：${state.bbrSummary || "已执行，等待总结。"}`;
  }
  if (stepId === "claude-test") {
    return `Claude 连通性结果：${state.claudeSummary || "已执行，等待总结。"}`;
  }
  if (stepId === "autofix-all") {
    return `Auto-Fix 结果：${state.autofixSummary || "已执行，等待总结。"}`;
  }
  return stdout;
}

async function runAutofix() {
  const desktopApi = window.vpsDesktop;
  if (!desktopApi?.runDeploymentAction) {
    showResultModal("无法执行 Auto-Fix", "当前是 Web 预览版，不能直接执行 Auto-Fix。请使用桌面版。");
    return;
  }

  if (!deployPrerequisitesReady()) {
    showResultModal("还不能执行 Auto-Fix", "请先完成 SSH 验证。");
    return;
  }

  const v = values();
  const target = el("autofixTarget").value;
  const force = el("autofixForce").checked;
  const button = el("runAutofix");
  const creds = deployCredentialsFor("verify-deploy-user");
  const payload = {
    action: `autofix-${target}`,
    host: v.ip,
    port: v.sshPort,
    sshPort: v.sshPort,
    servicePort: v.servicePort,
    protocolKey: state.protocol,
    protocolName: protocols[state.protocol].name,
    username: creds.username,
    password: creds.password,
    sudoPassword: creds.sudoPassword,
    hostFingerprint: v.hostFingerprint,
    serverName: v.serverName,
    force
  };

  const secrets = await ensureSecrets();
  payload.serverConfigJson = JSON.stringify(xrayServerConfig(v, secrets), null, 2);

  button.disabled = true;
  el("autofixStatus").classList.remove("success", "danger");
  el("autofixStatus").classList.add("pending");
  el("autofixStatus").textContent = "修复中";
  el("autofixResult").textContent = "正在检测、备份、修复并复测，请等待...";

  try {
    const result = await desktopApi.runDeploymentAction(payload);
    if (!result.ok) {
      el("autofixStatus").classList.remove("pending", "success");
      el("autofixStatus").classList.add("danger");
      el("autofixStatus").textContent = "失败";
      el("autofixResult").textContent = "自动修复未完成，请查看弹窗。";
      showResultModal("Auto-Fix 未完成", result.error || result.stderr || "Auto-Fix 执行失败。");
      log(`Auto-Fix 执行失败：${result.error || "未知错误"}。`);
      return;
    }

    state.autofixRaw = result.stdout || "";
    state.autofixSummary = autofixSummaryText(result.stdout || "");
    state.outputs.autofix = extractAutofixReport(result.stdout || "");
    el("autofixStatus").classList.remove("pending", "danger", "warning");
    el("autofixStatus").classList.add(/部分修复|遗留告警/.test(state.autofixSummary) ? "warning" : "success");
    el("autofixStatus").textContent = /部分修复|遗留告警/.test(state.autofixSummary) ? "部分完成" : "已完成";
    el("autofixResult").textContent = display(state.autofixSummary);
    if (/部分修复|遗留告警/.test(state.autofixSummary)) {
      showResultModal("Auto-Fix 仍有未完成项", extractAutofixReport(result.stdout || state.autofixSummary));
    }
    renderOutput();
    log(`Auto-Fix 已执行：${state.autofixSummary}`);
  } catch (error) {
    el("autofixStatus").classList.remove("pending", "success", "warning");
    el("autofixStatus").classList.add("danger");
    el("autofixStatus").textContent = "失败";
    el("autofixResult").textContent = display(error.message || "Auto-Fix 执行失败。");
    log(`Auto-Fix 执行失败：${error.message || "未知错误"}。`);
  } finally {
    button.disabled = false;
  }
}

async function generateAll() {
  try {
    const v = values();
    const secrets = await ensureSecrets();

    const selected = selectedClients();
    state.outputs = {
      script: deploymentScript(v, secrets),
      singbox: selected.includes("singbox") ? singBoxConfig(v, secrets) : "未选择 sing-box。勾选后重新生成即可。",
      mihomo: selected.includes("mihomo") ? mihomoConfig(v, secrets) : "未选择 Mihomo / Clash Meta。勾选后重新生成即可。",
      surge: selected.includes("surge") ? surgeConfig(v, secrets) : "未选择 Surge / Stash。勾选后重新生成即可。",
      links: selected.includes("links") ? linksConfig(v, secrets) : "未选择 Shadowrocket / v2rayN 链接。勾选后重新生成即可。",
      autofix: state.autofixRaw ? extractAutofixReport(state.autofixRaw) : "尚未执行 Auto-Fix。部署中的自动自愈或手动自愈完成后，这里会显示完整修复报告。",
      report: report(v)
    };

    setStep(3);
    renderOutput();
    log(`已在本地生成 ${protocols[state.protocol].name} 部署脚本和客户端配置：${clientSelectionText()}。`);
    log("敏感字段默认在界面和日志中打码，复制按钮会复制当前完整内容。");
  } catch (error) {
    log(`生成失败: ${error.message}`);
    el("outputCode").textContent = `生成失败：${error.message}\n\n建议使用最新版 Chrome / Edge / Safari，或在 localhost 环境运行本页面以启用 Web Crypto。`;
  }
}

function clearSensitiveData() {
  state.secrets = null;
  state.outputs = {};
  state.adminVerified = false;
  state.adminVerification = null;
  ["vpsIp", "adminPassword", "hostFingerprint"].forEach((id) => {
    el(id).value = "";
  });
  setAdminVerification("pending", "敏感数据已清空，请重新测试长期管理员账号。");
  renderOutput();
  state.claudeRaw = "";
  state.claudeSummary = "";
  state.bbrRaw = "";
  state.bbrSummary = "";
  state.autofixRaw = "";
  state.autofixSummary = "";
  el("autofixStatus").classList.remove("success", "danger");
  el("autofixStatus").classList.add("pending");
  el("autofixStatus").textContent = "未执行";
  el("autofixResult").textContent = "部署后如果发现 Claude / DNS / IPv6 / BBR / Xray / 防火墙异常，可以在这里直接一键自愈修复。";
  hideResultModal();
  log("已清空本页敏感数据和已生成配置。");
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

function bindEvents() {
  els(".client-target").forEach((box) => {
    box.addEventListener("change", () => {
      syncClientSelectAll();
      updateGenerateState();
      log(`客户端配置选择已更新：${clientSelectionText()}。`);
    });
  });

  el("selectAllClients").addEventListener("change", (event) => {
    els(".client-target").forEach((box) => {
      box.checked = event.target.checked;
    });
    updateGenerateState();
    log(`客户端配置选择已更新：${clientSelectionText()}。`);
  });

  ["vpsIp", "sshPort", "adminUser", "adminPassword"].forEach((id) => {
    el(id).addEventListener("input", () => {
      resetAdminVerification();
      resetDeployFlow(false);
    });
  });

  ["servicePort", "serverName", "hostFingerprint"].forEach((id) => {
    el(id).addEventListener("input", () => {
      if (["servicePort", "serverName"].includes(id)) {
        state.secrets = null;
      }
      resetDeployFlow(false);
      updateGenerateState();
    });
  });

  el("testAdminSsh").addEventListener("click", testAdminSsh);
  el("runDeployStep").addEventListener("click", runDeployStep);
  el("runAutofix").addEventListener("click", runAutofix);
  el("resetDeployFlow").addEventListener("click", () => resetDeployFlow(true));
  el("generateAll").addEventListener("click", generateAll);
  el("clearSecrets").addEventListener("click", clearSensitiveData);

  el("revealToggle").addEventListener("click", () => {
    state.reveal = !state.reveal;
    el("revealToggle").textContent = state.reveal ? "隐藏敏感字段" : "显示敏感字段";
    renderOutput();
    log(state.reveal ? "用户选择在本地界面显示敏感字段。" : "用户选择隐藏敏感字段。");
  });

  els("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      await copyText(el(button.dataset.copy).innerText);
      log("已复制命令。");
    });
  });

  els(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      els(".tab").forEach((tab) => tab.classList.remove("active"));
      button.classList.add("active");
      state.currentTab = button.dataset.tab;
      renderOutput();
    });
  });

  el("copyOutput").addEventListener("click", async () => {
    const content = state.outputs[state.currentTab];
    if (!content) return;
    await copyText(content);
    log(`已复制 ${el("outputTitle").textContent} 的完整内容。`);
  });

  el("closeResultModal").addEventListener("click", hideResultModal);
  el("copyResultModal").addEventListener("click", async () => {
    await copyText(el("resultModalBody").value);
    log("已复制部署结果提示。");
  });
  el("resultModal").addEventListener("click", (event) => {
    if (event.target === el("resultModal")) hideResultModal();
  });
}

bindEvents();
log("应用已在本地启动。当前仅提供标准部署模式和固定安全协议。");
