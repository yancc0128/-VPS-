# 自托管 VPS 安全部署助手

这是一个隐私优先的本地 Web MVP，用来引导普通用户安全部署自托管 VPS 代理/VPN 服务，并在本地生成客户端配置。

目标交付形态：

- Windows 桌面 App
- Android App
- 本地 Web 预览版

## 隐私原则

- 不收集、不上传、不保存 VPS IP、SSH 密码、私钥、节点配置、订阅链接或任何可识别用户身份的信息。
- SSH 临时密码只存在于当前页面内存，不写入日志、报告或导出文件。
- UUID、REALITY X25519 key、shortId、客户端配置都在本地浏览器生成。
- 展示配置和日志时默认打码 IP、UUID、私钥、订阅链接和可识别域名。
- 智能助手部署当前只提供本地脱敏预览，不会调用外部 AI 服务。

## 运行

```bash
npm run dev
```

然后打开：

```text
http://localhost:5173
```

## Windows 和 Android 方向

建议采用“一套本地 Web 核心 + 两个原生外壳”的架构：

- Windows：优先 Tauri，安装包小、系统集成好；如果后续需要大量 Node 生态能力，再考虑 Electron。
- Android：优先 Kotlin WebView 或 Capacitor。第一版可以包装当前页面，后续再逐步加入 Android Keystore、本地文件导出、二维码和 SSH 执行能力。
- 共用核心：部署流程、脱敏、密钥生成、客户端配置生成、安全报告都保留在同一套前端代码里。

当前版本可以作为 Windows/Android 的 Web 核心使用，但还不是正式安装包。下一步应创建：

- `apps/windows/`：Windows 桌面壳。
- `apps/android/`：Android App 壳。
- `shared/`：后续可把协议生成、脱敏、报告逻辑拆到共享模块。

## Windows portable 打包

当前项目已接入 Electron 和 electron-builder。Windows portable 包会本地加载 `dist/web/index.html`，不依赖线上网站。

```bash
npm install
npm run build:web
npm run dist:win
```

产物位置：

```text
release/VPS-Deploy-Assistant-Windows-0.1.0-portable.exe
```

Windows 用户拿到这个 `.exe` 后可以直接双击运行，不需要安装 Node.js、npm 或开发环境。

## macOS 打包

当前项目也可以打包 macOS 桌面版：

```bash
npm install
npm run build:web
npm run dist:mac
```

Apple Silicon 产物位置：

```text
release/VPS-Deploy-Assistant-macOS-0.1.0-arm64.dmg
release/VPS-Deploy-Assistant-macOS-0.1.0-arm64.zip
```

当前包未做 Apple Developer ID 签名和 notarization。首次打开时如果 macOS 拦截，可右键应用选择“打开”。正式分发时建议补签名和公证。

## 已覆盖流程

- 部署开始前选择标准部署或智能助手部署。
- 桌面版本机 SSH 验证长期管理员账号：测试 SSH 登录和 `sudo whoami`。
- 桌面版部署执行向导：用户只确认步骤，界面显示执行中状态和脱敏结果，不要求复制粘贴命令。
- 引导创建长期管理员账号 `myadmin`。
- 引导创建临时部署账号 `appdeploy`。
- 收集临时账号连接信息并提醒核对 host key 指纹。
- 部署前四项强制确认。
- 推荐协议：默认 VLESS + REALITY + Vision，并提供 Hysteria2、TUIC v5 场景说明。
- 本地生成：
  - Xray 服务端配置和部署脚本
  - sing-box 配置
  - Mihomo/Clash Meta 配置
  - Surge/Stash 配置
  - Shadowrocket/v2rayN VLESS 链接
- 生成本地安全检查报告。

## 重要说明

当前版本的 Web 预览版不会自动 SSH 连接 VPS，也不会自动执行部署命令。Electron 桌面版支持“长期管理员账号 SSH + sudo 验证”和预设部署执行向导，不开放任意 shell 命令。普通用户界面不展示 shell 命令，只显示步骤、执行中状态和脱敏结果；生成的脚本仍保留在输出页，作为审计和手动备用。后续继续扩展 SSH 自动部署层时，也应遵守：

- 命令执行前必须展示并确认。
- AI 不得自由执行任意 shell 命令。
- 不允许一键关闭防火墙。
- 部署完成前必须确认 SSH 端口未被防火墙封锁。
- 临时部署账号必须删除，并在报告中标明状态。
