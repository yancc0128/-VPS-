// SSH 认证配置的纯函数封装：支持密码与私钥两种方式，便于单测且让
// main.js / vps-helper.mjs 共用同一套凭据解析逻辑。

function normalizeKey(privateKey) {
  return typeof privateKey === "string" ? privateKey.trim() : "";
}

// 返回可直接展开进 ssh2 connect() 的认证片段。
// 有私钥优先用私钥（带可选 passphrase），否则回退密码。
function buildSshAuth({ password, privateKey, passphrase } = {}) {
  const key = normalizeKey(privateKey);
  if (key) {
    const auth = { privateKey: key };
    const pass = typeof passphrase === "string" ? passphrase : "";
    if (pass) auth.passphrase = pass;
    return auth;
  }
  return { password: String(password || "") };
}

// 至少要有一种凭据（私钥或密码）才允许发起连接。
function hasCredential({ password, privateKey } = {}) {
  return Boolean(normalizeKey(privateKey)) || Boolean(password);
}

// 下发给 `sudo -S` 的密码：优先用显式的 sudo 密码，否则回退登录密码。
// 私钥登录且未填 sudo 密码时返回空串，对应 NOPASSWD 场景。
function resolveSudoPassword({ sudoPassword, password } = {}) {
  if (sudoPassword) return String(sudoPassword);
  return String(password || "");
}

module.exports = {
  buildSshAuth,
  hasCredential,
  resolveSudoPassword
};
