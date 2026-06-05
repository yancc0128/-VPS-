const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSshAuth, hasCredential, resolveSudoPassword } = require("../scripts/ssh-auth.cjs");

test("无私钥时使用密码认证", () => {
  assert.deepEqual(buildSshAuth({ password: "secret" }), { password: "secret" });
});

test("有私钥时优先私钥，忽略密码", () => {
  const auth = buildSshAuth({ password: "secret", privateKey: "-----KEY-----" });
  assert.deepEqual(auth, { privateKey: "-----KEY-----" });
});

test("私钥带 passphrase 时一并返回", () => {
  const auth = buildSshAuth({ privateKey: "-----KEY-----", passphrase: "pp" });
  assert.deepEqual(auth, { privateKey: "-----KEY-----", passphrase: "pp" });
});

test("私钥 passphrase 为空串时不写入字段", () => {
  const auth = buildSshAuth({ privateKey: "-----KEY-----", passphrase: "" });
  assert.deepEqual(auth, { privateKey: "-----KEY-----" });
});

test("私钥首尾空白被裁剪", () => {
  const auth = buildSshAuth({ privateKey: "  -----KEY-----\n  " });
  assert.deepEqual(auth, { privateKey: "-----KEY-----" });
});

test("纯空白私钥视为无私钥，回退密码", () => {
  assert.deepEqual(buildSshAuth({ password: "pw", privateKey: "   \n" }), { password: "pw" });
});

test("缺少全部参数时密码为空串", () => {
  assert.deepEqual(buildSshAuth(), { password: "" });
});

test("hasCredential：有密码为真", () => {
  assert.equal(hasCredential({ password: "x" }), true);
});

test("hasCredential：有私钥为真", () => {
  assert.equal(hasCredential({ privateKey: "-----KEY-----" }), true);
});

test("hasCredential：两者皆空为假", () => {
  assert.equal(hasCredential({ password: "", privateKey: "  " }), false);
  assert.equal(hasCredential(), false);
});

test("resolveSudoPassword：显式 sudo 密码优先", () => {
  assert.equal(resolveSudoPassword({ sudoPassword: "sudo", password: "login" }), "sudo");
});

test("resolveSudoPassword：未填 sudo 密码回退登录密码", () => {
  assert.equal(resolveSudoPassword({ sudoPassword: "", password: "login" }), "login");
});

test("resolveSudoPassword：私钥登录且 NOPASSWD 时为空串", () => {
  assert.equal(resolveSudoPassword({ sudoPassword: "", password: "" }), "");
});
