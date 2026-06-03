const test = require("node:test");
const assert = require("node:assert/strict");
const { redactForAI } = require("../scripts/ai-explain.cjs");

test("脱敏 IPv4 地址", () => {
  assert.equal(redactForAI("出口 IP 203.0.113.10"), "出口 IP [IP已隐藏]");
});

test("脱敏完整 IPv6 地址（ipinfo 形式）", () => {
  const input = '"ip":"2401:c080:1400:6fd2:5400:04ff:fe11:2233"';
  const out = redactForAI(input);
  assert.match(out, /\[IPv6已隐藏\]/);
  assert.doesNotMatch(out, /2401:c080/);
});

test("脱敏纯数字 + :: 压缩的 IPv6", () => {
  const out = redactForAI("trace ip=2606:4700:3030::6815:1");
  assert.equal(out, "trace ip=[IPv6已隐藏]");
});

test("脱敏带 zone-id 的链路本地 IPv6", () => {
  assert.equal(redactForAI("fe80::1%eth0"), "[IPv6已隐藏]");
});

test("脱敏回环 IPv6", () => {
  assert.equal(redactForAI("listen ::1 ok"), "listen [IPv6已隐藏] ok");
});

test("不误伤时间戳", () => {
  const input = "TIME 2024-06-03T12:34:56Z";
  assert.equal(redactForAI(input), input);
});

test("不误伤普通日志里的冒号时间", () => {
  const input = "path C:\\Users at 09:30:00 done";
  assert.equal(redactForAI(input), input);
});

test("继续脱敏 UUID", () => {
  const out = redactForAI("id 123e4567-e89b-42d3-a456-426614174000");
  assert.match(out, /\[UUID已隐藏\]/);
});

test("继续脱敏 vless 订阅链接", () => {
  const out = redactForAI("vless://uuid@host:443?x=1#node");
  assert.match(out, /\[订阅链接已隐藏\]/);
});

test("放行基础设施域名", () => {
  assert.equal(redactForAI("connect claude.ai"), "connect claude.ai");
});
