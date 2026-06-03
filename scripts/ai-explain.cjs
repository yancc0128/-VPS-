const https = require("node:https");

// 主进程侧的二次脱敏：不信任渲染层是否已脱敏，发往云端前再过一遍。
// 与 app.js 的 sensitivePatterns 保持一致，少量基础设施域名放行以便 AI 理解上下文。
const SAFE_DOMAINS = new Set([
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
]);

const SENSITIVE_PATTERNS = [
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[IP已隐藏]"],
  // IPv6：要求出现十六进制字母或 `::` 压缩段，避免误伤 12:34:56 这类时间戳。
  [/(?<![0-9a-f:])(?=[0-9a-f:]*[a-f]|[0-9a-f:]*::)(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?:%[0-9a-z]+)?(?![0-9a-f:])/gi, "[IPv6已隐藏]"],
  [/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, "[UUID已隐藏]"],
  [
    /(privateKey|password|passwd|pwd|uuid|shortId|server|address|host|sni)(\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,\n]+)/gi,
    "$1$2[已隐藏]"
  ],
  [/vless:\/\/[^\s"']+/gi, "[订阅链接已隐藏]"],
  [
    /(?<![/\w-])(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|app|cn|top|xyz|cloud|co|me|info|biz|site|online|link)(?![\w-])/gi,
    (match) => (SAFE_DOMAINS.has(match.toLowerCase()) ? match : "[域名已隐藏]")
  ]
];

function redactForAI(text) {
  return SENSITIVE_PATTERNS.reduce(
    (value, [pattern, replacement]) => value.replace(pattern, replacement),
    String(text || "")
  );
}

const KIND_LABELS = {
  autofix: "VPS 自愈修复报告",
  claude: "Claude 连通性诊断",
  bbr: "BBR 拥塞控制诊断"
};

function buildMessages(kind, redactedText) {
  const label = KIND_LABELS[kind] || "VPS 诊断输出";
  const system = [
    "你是一名 VPS 网络运维助手，只负责解读诊断输出并给出排错思路。",
    "严格遵守：",
    "1. 只输出自然语言分析和下一步建议，绝不输出可直接执行的 shell 命令或配置文件。",
    "2. 文本里的 IP、域名、密钥等已被脱敏为占位符，不要追问或试图还原。",
    "3. 不确定时明确说明需要人工核验，不要编造结论。",
    "4. 用简体中文，先给一句话结论，再分点说明原因和建议，控制在 200 字以内。"
  ].join("\n");

  const user = `以下是${label}（敏感字段已脱敏），请解读并给出下一步建议：\n\n${redactedText}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

function callDeepSeek({ apiKey, baseUrl, model, messages, timeoutMs = 30000 }) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL("/chat/completions", baseUrl || "https://api.deepseek.com");
    } catch (_error) {
      resolve({ ok: false, error: "AI 服务地址无效。" });
      return;
    }

    const body = JSON.stringify({
      model: model || "deepseek-chat",
      messages,
      temperature: 0.2,
      max_tokens: 600,
      stream: false
    });

    const request = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(body)
        },
        timeout: timeoutMs
      },
      (response) => {
        let raw = "";
        response.on("data", (chunk) => {
          raw += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode || 0) >= 400) {
            resolve({ ok: false, error: `AI 接口返回 ${response.statusCode}。` });
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            const content = parsed?.choices?.[0]?.message?.content;
            if (typeof content === "string" && content.trim()) {
              resolve({ ok: true, text: content.trim() });
            } else {
              resolve({ ok: false, error: "AI 接口未返回有效内容。" });
            }
          } catch (_error) {
            resolve({ ok: false, error: "AI 接口响应解析失败。" });
          }
        });
      }
    );

    request.on("timeout", () => {
      request.destroy();
      resolve({ ok: false, error: "AI 接口请求超时。" });
    });
    request.on("error", () => {
      resolve({ ok: false, error: "AI 接口连接失败，请检查网络或服务地址。" });
    });

    request.write(body);
    request.end();
  });
}

async function explainDiagnostics({ apiKey, baseUrl, model, kind, text }) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return { ok: false, error: "没有可解读的诊断内容。" };
  }
  const redacted = redactForAI(trimmed);
  const messages = buildMessages(kind, redacted);
  return callDeepSeek({ apiKey, baseUrl, model, messages });
}

module.exports = {
  redactForAI,
  buildMessages,
  callDeepSeek,
  explainDiagnostics
};
