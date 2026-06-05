# VPS 部署助手 · 操作流程文档

> 本文档描述「VPS 半自动化部署助手」从连接到出节点的完整操作流程，与当前桌面端
> 实际交互（`app.js` 向导步骤 + `electron/main.js` 远程动作）保持一致。
> 协议固定为 **VLESS + REALITY + XTLS Vision**，服务端默认 `xray-core`。

## 0. 总览

```text
准备 ──▶ 连接 & 验证管理员 ──▶ 部署向导（9 步）──▶ 生成客户端配置 ──▶ （可选）自愈修复 / AI 解读
```

| 阶段 | 干什么 | 关键产物 |
|------|--------|----------|
| 准备 | 一台干净 VPS + 一个能 `sudo` 的长期管理员账号 | 登录信息 |
| 连接 | 填 IP/端口/账号密码，SSH 登录 + `sudo whoami` 测试 | 主机指纹（TOFU 记录） |
| 部署 | 按 9 步向导初始化系统、装依赖、开 BBR、配防火墙、装服务、验证 | 服务端 `config.json` |
| 出节点 | 生成各客户端订阅/配置 | sing-box / Mihomo / Surge / 链接 |
| 维护 | 自愈修复 + 可选 AI 诊断解读 | 修复报告 + 回滚命令 |

---

## 1. 准备阶段（前置条件）

- **一台 VPS**：Debian/Ubuntu 系（脚本依赖 `apt-get`、`systemctl`、`ufw`）。
- **一个长期管理员账号**：能 SSH 登录且 `sudo` 可提权到 `root`（当前向导以已有管理员身份执行，不再现场创建临时用户）。
- **放行 SSH 端口**：确保你的 SSH 端口（默认 22）当前可连。
- **安装本工具**：macOS 用 `release/*.dmg`，Windows 用 `release/*-portable.exe`；或开发模式 `npm run preview`。

> 隐私边界：VPS IP、SSH/sudo 密码、私钥、UUID、Reality `privateKey`、`shortId`、订阅链接
> **全部只留在本机**，不上传任何服务器。

---

## 2. 连接与验证管理员

界面填写并点击「测试长期管理员」(`testAdminSsh`)：

1. 输入 **VPS IP、SSH 端口、管理员用户名、密码**。
2. （可选）填 **Host key 指纹**做首次预校验；留空则首次连接自动记录。
3. 工具执行 `uname -a && sudo -S -p '' whoami`，**要求 `sudo whoami` 输出 `root`** 才算通过。
4. **主机指纹 TOFU**：首次连接把 SHA256 指纹写入 `known_hosts.json`（`0600`）；之后每次比对，
   **指纹不一致直接拒绝连接**并提示（可能是重装/换 IP/中间人）。

✅ 通过后 `state.adminVerified = true`，才能进入部署向导。

---

## 3. 部署向导（按顺序 9 步）

每一步通过 `runDeploymentAction` 下发，远程统一用 `sudo -S -p '' bash -lc <脚本>` 执行
（`system-check` 例外，不提权）。脚本里的协议配置以 **base64 传输、远程解码写入**，防注入。

| # | 动作 id | 步骤 | 远程做了什么 |
|---|---------|------|--------------|
| 1 | `verify-deploy-user` | 验证长期管理员权限 | `whoami && sudo -S -p '' whoami` 确认可提权 |
| 2 | `system-check` | 检查系统环境 | `uname -a` / `lsb_release` / 确认有 `apt-get` |
| 3 | `install-dependencies` | 安装必要依赖 | `apt-get install -y curl unzip tar ca-certificates ufw` |
| 4 | `enable-bbr-soft` | 检测并开启 BBR | 写 `99-bbr.conf`（`fq` + `bbr`），不支持则结束时说明原因 |
| 5 | `configure-firewall` | 配置防火墙 | `ufw allow <sshPort>/tcp` + `<servicePort>/tcp`，`ufw --force enable`（**不关防火墙**） |
| 6 | `install-proxy-service` | 部署 VLESS+REALITY+Vision | 装 `xray`，base64 解码写 `/usr/local/etc/xray/config.json`，`systemctl enable/restart xray` |
| 7 | `verify-service` | 测试服务状态 | `systemctl status xray` + `ss -tulpen | grep :<servicePort>` |
| 8 | `claude-test` | 检测 Claude 连通性 | 检测出口 IP / DNS / IPv6 / Claude 相关域名 TLS+HTTP2 |
| 9 | `autofix-all` | 自动自愈修复 | 检测到异常自动修复，结束后列出仍未完成项 |

> 协议名走白名单校验（`safeProtocolName`），不在允许列表会直接报错，杜绝命令注入。

部署成功后 `state.deploymentCompleted = true`。

---

## 4. 生成客户端配置

`adminVerified` + `deploymentCompleted` + 已填 IP/端口/已选客户端 后，「一键生成」(`generateAll`) 可用。

可选导出目标（`clientTargets`）：

- **sing-box**
- **Mihomo / Clash Meta**
- **Surge / Stash**
- **Shadowrocket / v2rayN**（链接形式）

Reality 密钥对在本机用 Node `crypto`（X25519）生成，**私钥不出本机**。

---

## 5. 自愈修复（按需）

`autofix-<target>`，分级执行，所有修改先 **备份**（`*.bak.<时间戳>`）并产出 **回滚命令**：

| target | 修什么 | 级别 |
|--------|--------|------|
| `claude` | DNS / IPv6 / BBR / Xray / Claude 分流规则一条龙 | L1+L2 |
| `dns` | resolver 异常/国内 DNS → 切 1.1.1.1/8.8.8.8/9.9.9.9 | L1 |
| `ipv6` | 检测到 IPv6 出口或地区不一致 → sysctl 关闭 IPv6 | L1 |
| `bbr` | 未开启 → 写 `99-bbr.conf` 并 `sysctl --system` | L1 |
| `xray` | 未运行/配置错/Reality 参数缺失/端口未监听 → 重写标准配置 | L2 |
| `firewall` | UFW 未启用或缺放行规则 | **L3，默认跳过** |
| `all` | 以上全部 | L1+L2（防火墙需 `--force`） |

> ⚠️ **防火墙是 Level 3 高风险**，默认只提示、不执行；需显式 `autofix --force` 才会动 `ufw`。
> 报告写到 `/root/vps-helper-autofix-report.md`，并同步一份到 `~/Obsidian/VPS/VPS 配置.md`。
> 回滚：直接执行报告「回滚命令」段落里列出的命令。

---

## 6. （可选）AI 诊断解读

默认**关闭、可随时跳过**，不配置也能完成全部部署。

- 在设置里启用并填 API Key（默认 DeepSeek，OpenAI 兼容，可改地址/模型）。
- Key 仅存本机用户目录（`0600`），**不回传界面、不写日志**。
- 发送前**二次脱敏**：IP / IPv6 / 域名 / UUID / 密钥 / 订阅链接 → 占位符；
  **绝不发送** SSH 密码、sudo 密码、主机指纹。
- AI **只输出文字分析，不生成/执行任何远程命令**；不可用/超时自动回退本地规则总结。

---

## 7. 安全与隐私边界（始终生效）

- SSH 主机密钥 TOFU 校验，指纹不符拒连。
- 远程脚本 base64 传输 + 协议名白名单，防注入 / 防 heredoc 提前结束。
- 渲染层严格 CSP（`connect-src 'none'`），所有外发请求只在主进程按需发起。
- 敏感字段界面默认隐藏；本地优先，不上传。

---

## 8. 故障排查速查

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 管理员验证失败、`sudo whoami` 非 root | 账号无 sudo / 密码错 | 换有 sudo 权限的账号；确认密码 |
| 连接被拒、提示指纹不一致 | VPS 重装/换 IP，或中间人 | 人工核对指纹，确认安全后清掉 `known_hosts.json` 旧记录 |
| `install-proxy-service` 失败 | 无 `systemctl` / 装 xray 失败 | 确认是 systemd 系统；查网络能否访问 GitHub |
| `verify-service` 端口未监听 | xray 未起或配置错 | 跑 `autofix-xray`，看回滚前后报告 |
| Claude 仍不通但 ChatGPT 可访问 | 出口 IP/ASN 被风控 | 换更干净出口 / 住宅家宽 ASN |
| BBR 开不起来 | 内核过低 | 升级内核后重试 `autofix-bbr` |

---

## 附：开发与构建

```bash
npm run preview     # 本地构建 web 并起 Electron 预览
npm run check       # node --check app.js 语法自检
npm test            # 运行 test/**/*.test.cjs
npm run dist:mac    # 打包 macOS dmg + zip (arm64)
npm run dist:win    # 打包 Windows portable (x64)
```
