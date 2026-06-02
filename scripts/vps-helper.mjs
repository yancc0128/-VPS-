#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Client } from "ssh2";
import { helperActionScript } from "./remote-actions.cjs";
import sshTrust from "./ssh-trust.cjs";

const { createHostVerifier } = sshTrust;

function usage() {
  console.log(`vps-helper autofix [target] [options]

Targets:
  claude | dns | ipv6 | bbr | xray | firewall

Examples:
  VPS_HOST=203.0.113.10 VPS_USER=myadmin VPS_PASSWORD='***' vps-helper autofix claude
  VPS_HOST=203.0.113.10 VPS_USER=myadmin VPS_PASSWORD='***' vps-helper autofix dns
  VPS_HOST=203.0.113.10 VPS_USER=myadmin VPS_PASSWORD='***' vps-helper autofix firewall --force

Options:
  --host            VPS IP
  --port            SSH port, default 22
  --username        SSH username
  --password        SSH password, prefer VPS_PASSWORD env to avoid shell history
  --sudo-password   sudo password, default same as --password
  --host-fingerprint expected SSH host key fingerprint, SHA256:...
  --ssh-port        current SSH service port, default same as --port
  --service-port    proxy service port, default 443
  --server-name     REALITY serverName, default www.cloudflare.com
  --server-config   local xray config json path used for xray / claude autofix
  --force           allow Level 3 high-risk fixes

Env fallback:
  VPS_HOST VPS_PORT VPS_USER VPS_PASSWORD VPS_SUDO_PASSWORD VPS_HOST_FINGERPRINT VPS_SSH_PORT VPS_SERVICE_PORT VPS_SERVER_NAME
`);
}

function parseArgs(argv) {
  const result = {
    _: [],
    force: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }

    const key = token.slice(2);
    if (key === "force") {
      result.force = true;
      continue;
    }

    if (key === "help") {
      result.help = true;
      continue;
    }

    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`缺少参数值：--${key}`);
    }
    result[key] = next;
    i += 1;
  }

  return result;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function knownHostsPath() {
  return process.env.VPS_HELPER_KNOWN_HOSTS || path.join(os.homedir(), ".vps-helper-known-hosts.json");
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
      expectedFingerprint: expectedHostFingerprint
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
      script = helperActionScript(action, actionPayload || {});
    } catch (error) {
      resolve({ ...result, error: error.message || "动作生成失败。" });
      return;
    }

    conn
      .on("ready", () => {
        const wrapped = `sudo -S -p '' bash -lc ${shellQuote(script)}`;
        conn.exec(wrapped, { pty: false }, (err, stream) => {
          if (err) {
            finish({ error: "SSH 已连接，但无法执行 autofix 动作。" });
            return;
          }

          stream
            .on("close", (code) => {
              finish({
                ok: code === 0,
                error: code === 0 ? "" : result.stderr || "autofix 执行失败。"
              });
            })
            .on("data", (data) => {
              result.stdout += data.toString("utf8");
            })
            .stderr.on("data", (data) => {
              result.stderr += data.toString("utf8");
            });

          stream.write(`${sudoPassword || password}\n`);
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command, maybeTarget = "all"] = args._;
  const target = maybeTarget === "--help" ? "all" : maybeTarget;

  if (!command || command === "help" || command === "--help" || args.help || maybeTarget === "--help") {
    usage();
    process.exit(0);
  }

  if (command !== "autofix") {
    throw new Error("当前 CLI 仅支持 autofix 子命令。");
  }

  const host = args.host || process.env.VPS_HOST;
  const port = args.port || process.env.VPS_PORT || "22";
  const username = args.username || process.env.VPS_USER;
  const password = args.password || process.env.VPS_PASSWORD;
  const sudoPassword = args["sudo-password"] || process.env.VPS_SUDO_PASSWORD || password;
  const expectedHostFingerprint = args["host-fingerprint"] || process.env.VPS_HOST_FINGERPRINT || "";
  const sshPort = args["ssh-port"] || process.env.VPS_SSH_PORT || port;
  const servicePort = args["service-port"] || process.env.VPS_SERVICE_PORT || "443";
  const serverName = args["server-name"] || process.env.VPS_SERVER_NAME || "www.cloudflare.com";

  if (!host || !username || !password) {
    usage();
    throw new Error("缺少 --host / --username / --password。");
  }

  let serverConfigJson = "";
  if (args["server-config"]) {
    serverConfigJson = fs.readFileSync(args["server-config"], "utf8");
  }

  const action = target === "all" ? "autofix-all" : `autofix-${target}`;
  const payload = {
    action,
    sshPort,
    servicePort,
    serverName,
    force: Boolean(args.force),
    serverConfigJson
  };

  const result = await runSshAction({
    host,
    port,
    username,
    password,
    sudoPassword,
    action,
    actionPayload: payload,
    expectedHostFingerprint
  });

  process.stdout.write(result.stdout || "");
  if (!result.ok) {
    process.stderr.write(result.error || result.stderr || "autofix 执行失败。\n");
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message || "vps-helper 执行失败。"}\n`);
  process.exit(1);
});
