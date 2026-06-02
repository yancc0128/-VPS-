const fs = require("node:fs");
const path = require("node:path");

function hostKey(host, port) {
  return `${String(host || "").trim().toLowerCase()}:${Number(port) || 22}`;
}

function normalizeFingerprint(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.startsWith("SHA256:") ? text : `SHA256:${text}`;
}

function loadKnownHosts(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && parsed.hosts && typeof parsed.hosts === "object"
      ? parsed
      : { version: 1, hosts: {} };
  } catch (_error) {
    return { version: 1, hosts: {} };
  }
}

function saveKnownHosts(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const next = {
    version: 1,
    hosts: data.hosts || {}
  };
  fs.writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

function createHostVerifier({ knownHostsPath, host, port, expectedFingerprint = "", onFingerprint }) {
  const key = hostKey(host, port);
  const expected = normalizeFingerprint(expectedFingerprint);
  let fingerprint = "";
  let rejection = "";

  return {
    hostHash: "sha256",
    hostVerifier: (hash) => {
      fingerprint = normalizeFingerprint(hash);
      if (typeof onFingerprint === "function") onFingerprint(fingerprint);

      const knownHosts = loadKnownHosts(knownHostsPath);
      const previous = knownHosts.hosts[key];

      if (previous?.fingerprint && previous.fingerprint !== fingerprint) {
        rejection = [
          "SSH 主机指纹不一致，已拒绝连接。",
          `已信任指纹：${previous.fingerprint}`,
          `本次指纹：${fingerprint}`,
          "这可能表示 VPS 重装、IP 更换或中间人攻击。请人工核对后再继续。"
        ].join("\n");
        return false;
      }

      if (!previous && expected && expected !== fingerprint) {
        rejection = [
          "SSH 主机指纹与用户填写值不一致，已拒绝连接。",
          `用户填写：${expected}`,
          `本次指纹：${fingerprint}`
        ].join("\n");
        return false;
      }

      const now = new Date().toISOString();
      knownHosts.hosts[key] = {
        host: String(host || "").trim(),
        port: Number(port) || 22,
        fingerprint,
        firstSeenAt: previous?.firstSeenAt || now,
        lastSeenAt: now
      };
      saveKnownHosts(knownHostsPath, knownHosts);
      return true;
    },
    getFingerprint: () => fingerprint,
    getRejection: () => rejection
  };
}

module.exports = {
  createHostVerifier,
  normalizeFingerprint
};
