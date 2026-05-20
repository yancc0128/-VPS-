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
  mode: null,
  protocol: "vless",
  deployIdentity: "temporary",
  reveal: false,
  outputs: {},
  currentTab: "script",
  secrets: null,
  adminVerified: false,
  adminVerification: null,
  deploymentStepIndex: 0,
  deploymentCompleted: false,
  deploymentRunning: false
};

const el = (id) => document.getElementById(id);
const els = (selector) => Array.from(document.querySelectorAll(selector));

const sensitivePatterns = [
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP已隐藏]"],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "[UUID已隐藏]"],
  [/(privateKey|password|passwd|pwd|uuid|shortId|server|address|host|sni)(\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,\n]+)/gi, "$1$2[已隐藏]"],
  [/vless:\/\/[^\s"']+/gi, "[订阅链接已隐藏]"],
  [/(?<![\/\w-])(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cn|top|xyz|cloud|co|me|info|biz|site|online|link)(?![\w-])/gi, (match) => {
    const safeInfrastructureDomains = ["www.cloudflare.com", "github.com", "raw.githubusercontent.com"];
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
    tempUser: el("tempUser").value.trim() || "appdeploy",
    deployIdentity: state.deployIdentity,
    servicePort: el("servicePort").value.trim() || protocols[state.protocol].port,
    serverName: el("serverName").value.trim() || "www.cloudflare.com",
    hostFingerprint: el("hostFingerprint").value.trim()
  };
}

function validInputs() {
  const v = values();
  const checks = els(".precheck").every((box) => box.checked);
  const identityReady = state.deployIdentity === "admin" || Boolean(v.tempUser && el("tempPassword").value);
  return Boolean(state.mode && state.adminVerified && state.deploymentCompleted && v.ip && v.sshPort && identityReady && v.servicePort && checks && selectedClients().length);
}

function updateGenerateState() {
  el("generateAll").disabled = !validInputs();
  updateDeployRunnerState();
}

function setStep(index) {
  els(".steps li").forEach((item, i) => item.classList.toggle("active", i === index));
}

function setupProtocols() {
  const grid = el("protocolGrid");
  grid.innerHTML = "";

  Object.entries(protocols).forEach(([key, protocol]) => {
    const card = document.createElement("div");
    card.className = `protocol-card ${key === state.protocol ? "selected" : ""}`;
    card.innerHTML = `
      <div class="protocol-title">${protocol.name}</div>
      <div class="protocol-copy">${protocol.summary}</div>
      <button class="ghost" type="button">选择</button>
    `;
    card.querySelector("button").addEventListener("click", () => {
      state.protocol = key;
      el("servicePort").value = protocol.port;
      state.secrets = null;
      setupProtocols();
      resetDeployFlow(false);
      log(`协议选择为 ${protocol.name}`);
    });
    grid.append(card);
  });
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

function syncDeployIdentity() {
  state.deployIdentity = document.querySelector("input[name='deployIdentity']:checked").value;
  const useTemporary = state.deployIdentity === "temporary";
  el("temporaryAccountPanel").classList.toggle("muted-panel", !useTemporary);
  el("tempUser").disabled = !useTemporary;
  el("tempPassword").disabled = !useTemporary;
  el("confirmTempCleanup").disabled = !useTemporary;

  if (!useTemporary) {
    el("confirmTempCleanup").checked = true;
  }

  const selectedCard = document.querySelector("input[name='deployIdentity']:checked").closest(".choice-card");
  document.querySelectorAll("input[name='deployIdentity']").forEach((input) => {
    input.closest(".choice-card").classList.remove("selected");
  });
  selectedCard.classList.add("selected");

  updateGenerateState();
  resetDeployFlow(false);
}

function deploySteps() {
  const common = [
    { id: "verify-deploy-user", title: "验证部署账号权限", hint: "确认当前部署账号可以执行 sudo。" },
    { id: "system-check", title: "检查系统环境", hint: "检查系统版本、CPU 架构和基础包管理器。" },
    { id: "install-dependencies", title: "安装必要依赖", hint: "安装 curl、unzip、tar、ca-certificates、ufw 等组件。" },
    { id: "configure-firewall", title: "配置防火墙", hint: "只开放 SSH 端口和代理服务端口，不关闭防火墙。" },
    { id: "install-proxy-service", title: `部署 ${protocols[state.protocol].name}`, hint: "按已选择的协议安装并配置服务端。" },
    { id: "verify-service", title: "测试服务状态", hint: "确认代理服务已启动，服务端口可监听。" }
  ];

  if (state.deployIdentity === "temporary") {
    return [
      { id: "create-temporary", title: "创建临时部署账号", hint: "使用长期管理员账号创建 appdeploy 并授予 sudo。" },
      ...common
    ];
  }

  return common;
}

function renderDeploySteps() {
  const list = el("deployStepList");
  list.innerHTML = "";
  deploySteps().forEach((step, index) => {
    const item = document.createElement("li");
    if (index < state.deploymentStepIndex) item.className = "done";
    if (index === state.deploymentStepIndex && state.deploymentRunning) item.className = "running";
    if (index === state.deploymentStepIndex && !state.deploymentRunning && !state.deploymentCompleted) item.className = "active";
    item.textContent = step.title;
    list.append(item);
  });
}

function resetDeployFlow(shouldLog = true) {
  state.deploymentStepIndex = 0;
  state.deploymentCompleted = false;
  state.deploymentRunning = false;
  el("deployRunStatus").classList.remove("success", "danger");
  el("deployRunStatus").classList.add("pending");
  el("deployRunStatus").textContent = "未开始";
  el("deployCurrentTitle").textContent = "等待开始";
  el("deployCurrentHint").textContent = "完成 SSH 验证和部署前确认后，点击开始部署。";
  el("deployResult").textContent = "暂无执行结果。";
  renderDeploySteps();
  updateGenerateState();
  if (shouldLog) log("部署执行向导已重置。");
}

function deployPrerequisitesReady() {
  const v = values();
  const checks = els(".precheck").every((box) => box.checked);
  const identityReady = state.deployIdentity === "admin" || Boolean(v.tempUser && el("tempPassword").value);
  return Boolean(state.mode && state.adminVerified && v.ip && v.sshPort && identityReady && checks);
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

function deployCredentialsFor(stepId) {
  const v = values();
  const adminPassword = el("adminPassword").value;
  const tempPassword = el("tempPassword").value;

  if (stepId === "create-temporary" || state.deployIdentity === "admin") {
    return {
      username: v.adminUser,
      password: adminPassword,
      sudoPassword: adminPassword
    };
  }

  return {
    username: v.tempUser,
    password: tempPassword,
    sudoPassword: tempPassword
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
    tempUser: v.tempUser,
    tempPassword: el("tempPassword").value
  };

  if (step.id === "install-proxy-service") {
    const secrets = await ensureSecrets();
    payload.serverConfigJson = JSON.stringify(xrayServerConfig(v, secrets), null, 2);
  }

  el("deployRunStatus").classList.remove("success", "danger");
  el("deployRunStatus").classList.add("pending");
  el("deployRunStatus").textContent = "执行中";
  el("deployCurrentTitle").textContent = step.title;
  el("deployCurrentHint").textContent = step.hint || "正在安装或配置，请等待。不要关闭应用。";
  el("deployResult").textContent = "正在执行，请等待...";
  updateDeployRunnerState();

  const result = await window.vpsDesktop.runDeploymentAction(payload);

  if (!result.ok) {
    el("deployRunStatus").classList.remove("pending");
    el("deployRunStatus").classList.add("danger");
    el("deployRunStatus").textContent = "失败";
    el("deployResult").textContent = display(result.error || result.stderr || "当前步骤执行失败。");
    log(`${step.title} 执行失败：${result.error || "未知错误"}。`);
    return false;
  }

  state.deploymentStepIndex += 1;
  if (state.deploymentStepIndex >= steps.length) {
    state.deploymentCompleted = true;
    el("deployRunStatus").classList.remove("pending", "danger");
    el("deployRunStatus").classList.add("success");
    el("deployRunStatus").textContent = "已完成";
    el("deployResult").textContent = display(`${result.stdout || "服务端部署已完成。"}\n\n现在可以在下一步生成客户端配置和订阅链接。`);
  } else {
    el("deployResult").textContent = display(result.stdout || "当前步骤已完成。");
  }
  log(`${step.title} 已完成。`);
  updateDeployRunnerState();
  return true;
}

async function runDeployStep() {
  const desktopApi = window.vpsDesktop;
  if (!desktopApi?.runDeploymentAction) {
    el("deployResult").textContent = "当前是 Web 预览版，不能直接执行远程部署。请使用桌面版。";
    log("当前环境不支持远程部署执行，请使用 Electron 桌面版。");
    return;
  }

  if (!deployPrerequisitesReady()) {
    el("deployResult").textContent = "请先完成 SSH 验证、部署身份选择和部署前确认。";
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
    el("deployRunStatus").textContent = "失败";
    el("deployResult").textContent = display(error.message || "当前步骤执行失败。");
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
      password
    });

    state.adminVerification = result;
    state.adminVerified = Boolean(result.ok);

    if (result.hostFingerprint) {
      el("hostFingerprint").value = result.hostFingerprint;
    }

    if (result.ok) {
      el("confirmAdminCreated").checked = true;
      el("confirmAdminSsh").checked = true;
      el("confirmAdminSudo").checked = true;
      if (state.deployIdentity === "admin") {
        el("confirmTempCleanup").checked = true;
      }
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
  const useTemporary = state.deployIdentity === "temporary";
  const deployUser = useTemporary ? v.tempUser : v.adminUser;
  const cleanupStep = useTemporary
    ? `echo "[8/8] 删除临时部署账号"
if command -v deluser >/dev/null 2>&1; then
  sudo deluser --remove-home "\${TEMP_USER}" || true
else
  sudo userdel -r "\${TEMP_USER}" || true
fi

echo "部署完成。临时部署账号 ${v.tempUser} 已删除。以后请使用你的长期管理员账号 ${v.adminUser} 管理 VPS。"`
    : `echo "[8/8] 跳过临时账号删除"
echo "部署完成。本次选择直接使用长期管理员账号 ${v.adminUser} 部署，没有创建或删除临时账号。"`;

  return `#!/usr/bin/env bash
set -Eeuo pipefail

TEMP_USER="${v.tempUser}"
DEPLOY_USER="${deployUser}"
SSH_PORT="${v.sshPort}"
SERVICE_PORT="${v.servicePort}"
PROTOCOL="${protocolName}"
DEPLOY_IDENTITY="${useTemporary ? "temporary" : "admin"}"

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

echo "[5/8] 写入 ${protocolName} 服务配置"
sudo install -d -m 755 /usr/local/etc/xray
sudo tee /usr/local/etc/xray/config.json >/dev/null <<'XRAY_CONFIG'
${xrayConfig}
XRAY_CONFIG

echo "[6/8] 启动服务并测试状态"
sudo systemctl enable xray
sudo systemctl restart xray
sudo systemctl --no-pager --full status xray
sudo ss -tulpen | grep ":\${SERVICE_PORT}" || (echo "服务端口未监听" >&2; exit 1)

echo "[7/8] 确认 SSH 端口仍开放"
sudo ufw status | grep "\${SSH_PORT}/tcp" || (echo "SSH 端口未开放，停止删除临时账号" >&2; exit 1)

${cleanupStep}
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
  const aiState = state.mode === "ai" ? "已启用，受限为本地脱敏和预设建议" : "未启用";
  const clients = clientSelectionText();
  const useTemporary = state.deployIdentity === "temporary";
  return `本地安全检查报告

服务状态: 部署脚本包含 systemctl enable/restart/status xray 检查
开放端口: SSH ${v.sshPort}/tcp，代理 ${v.servicePort}/tcp
防火墙状态: ufw 启用，只开放 SSH 和代理服务端口；不提供一键关闭防火墙
协议类型: ${protocols[state.protocol].name}
客户端配置生成状态: ${clients} 已在本地生成
长期管理员验证状态: ${state.adminVerified ? "已通过 SSH 登录和 sudo 测试" : "未通过"}
部署身份策略: ${useTemporary ? `创建临时部署账号 ${v.tempUser} 并切换部署` : `直接使用长期管理员账号 ${v.adminUser} 部署`}
临时账号删除状态: ${useTemporary ? `脚本末尾执行 deluser --remove-home ${v.tempUser}，无 deluser 时回退 userdel -r` : "未使用临时账号，跳过删除"}
AI 辅助状态: ${aiState}
Host key 指纹: ${v.hostFingerprint || "用户尚未填写"}
隐私状态: 不收集、不上传、不保存 VPS IP、SSH 密码、私钥、节点配置或订阅链接
日志脱敏: 已隐藏 IP、密码、UUID、私钥、订阅链接和可识别域名

完成提示:
${useTemporary ? `部署完成。临时部署账号 ${v.tempUser} 已删除。以后请使用你的长期管理员账号 ${v.adminUser} 管理 VPS。` : `部署完成。本次直接使用长期管理员账号 ${v.adminUser} 部署。`}
`;
}

function renderOutput() {
  const content = state.outputs[state.currentTab] || "请先生成内容。";
  const titles = {
    script: "部署脚本",
    singbox: "sing-box 配置",
    mihomo: "Mihomo/Clash Meta 配置",
    surge: "Surge / Stash 配置",
    links: "Shadowrocket / v2rayN 链接",
    report: "安全报告"
  };
  el("outputTitle").textContent = titles[state.currentTab];
  el("outputCode").textContent = display(content);
  el("copyOutput").disabled = !state.outputs[state.currentTab];
}

async function generateAll() {
  try {
    const v = values();
    const tempPassword = el("tempPassword").value;
    if (state.deployIdentity === "temporary" && !tempPassword) {
      log("临时密码为空。请填写临时部署账号密码后再生成部署内容。");
      return;
    }

    const secrets = await ensureSecrets();

    const selected = selectedClients();
    state.outputs = {
      script: deploymentScript(v, secrets),
      singbox: selected.includes("singbox") ? singBoxConfig(v, secrets) : "未选择 sing-box。勾选后重新生成即可。",
      mihomo: selected.includes("mihomo") ? mihomoConfig(v, secrets) : "未选择 Mihomo / Clash Meta。勾选后重新生成即可。",
      surge: selected.includes("surge") ? surgeConfig(v, secrets) : "未选择 Surge / Stash。勾选后重新生成即可。",
      links: selected.includes("links") ? linksConfig(v, secrets) : "未选择 Shadowrocket / v2rayN 链接。勾选后重新生成即可。",
      report: report(v)
    };

    setStep(4);
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
  ["vpsIp", "adminPassword", "tempPassword", "hostFingerprint"].forEach((id) => {
    el(id).value = "";
  });
  setAdminVerification("pending", "敏感数据已清空，请重新测试长期管理员账号。");
  renderOutput();
  log("已清空本页敏感数据和已生成配置。");
}

async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

function bindEvents() {
  els("input[name='deployMode']").forEach((input) => {
    input.addEventListener("change", () => {
      els(".choice-card").forEach((card) => card.classList.remove("selected"));
      input.closest(".choice-card").classList.add("selected");
    });
  });

  el("confirmMode").addEventListener("click", () => {
    state.mode = document.querySelector("input[name='deployMode']:checked").value;
    el("modeGate").classList.add("hidden");
    el("appBody").classList.remove("hidden");
    el("aiPanel").classList.toggle("hidden", state.mode !== "ai");
    setStep(1);
    log(state.mode === "ai" ? "已选择智能助手部署：仅允许本地脱敏内容进入 AI。" : "已选择标准部署：不启用 AI，不上传日志或配置。");
    updateGenerateState();
  });

  el("backToMode").addEventListener("click", () => {
    state.mode = null;
    state.adminVerified = false;
    el("appBody").classList.add("hidden");
    el("modeGate").classList.remove("hidden");
    el("aiPanel").classList.add("hidden");
    setStep(0);
    updateGenerateState();
    log("已返回部署模式选择，表单内容保留在本地页面内存中。");
  });

  el("disableAi").addEventListener("click", () => {
    state.mode = "standard";
    el("aiPanel").classList.add("hidden");
    log("用户已关闭 AI 辅助，切换回标准部署。");
    renderOutput();
  });

  el("sanitizeAi").addEventListener("click", () => {
    const sanitized = redact(el("aiInput").value);
    el("aiOutput").textContent = sanitized || "没有可处理的内容。";
    log("已生成本地脱敏内容。");
  });

  els(".precheck").forEach((box) => {
    box.addEventListener("change", () => {
      resetDeployFlow(false);
      updateGenerateState();
    });
  });
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

  els("input[name='deployIdentity']").forEach((input) => {
    input.addEventListener("change", () => {
      syncDeployIdentity();
      log(state.deployIdentity === "temporary" ? "部署身份选择为：创建临时账号并切换部署。" : "部署身份选择为：直接使用长期管理员账号部署。");
    });
  });

  ["vpsIp", "sshPort", "adminUser", "adminPassword"].forEach((id) => {
    el(id).addEventListener("input", () => {
      resetAdminVerification();
      resetDeployFlow(false);
    });
  });

  ["tempUser", "servicePort", "serverName", "hostFingerprint"].forEach((id) => {
    el(id).addEventListener("input", () => {
      if (["servicePort", "serverName"].includes(id)) {
        state.secrets = null;
      }
      resetDeployFlow(false);
      updateGenerateState();
    });
  });

  el("tempPassword").addEventListener("input", () => {
    resetDeployFlow(false);
    updateGenerateState();
  });

  el("testAdminSsh").addEventListener("click", testAdminSsh);
  el("runDeployStep").addEventListener("click", runDeployStep);
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
}

setupProtocols();
bindEvents();
syncDeployIdentity();
log("应用已在本地启动。请选择标准部署或智能助手部署。");
