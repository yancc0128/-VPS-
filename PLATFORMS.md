# Windows 与 Android 多端方案

## 推荐结论

可以做成 Windows 和 Android 都能使用。建议先做跨端 MVP，再逐步原生化关键能力。

## 第一阶段：最快可用

### Windows

使用 Tauri 包装当前本地 Web 应用。

优点：

- 安装包体积小。
- 可以访问本地文件系统、剪贴板、保存配置文件。
- 适合“本地生成脚本、配置、二维码、安全报告”的隐私工具。

第一版能力：

- 打开本地界面。
- 本地生成配置。
- 导出 `.json`、`.yaml`、`.conf`、`.txt`。
- 复制客户端链接。
- 保存本地安全报告。

暂不建议第一版自动 SSH 执行命令。等流程稳定后再加。

### Android

使用 Kotlin WebView 或 Capacitor 包装当前本地 Web 应用。

第一版能力：

- 本地生成配置。
- 复制链接。
- 分享配置文件给 sing-box、Mihomo、v2rayN 兼容工具。
- 生成二维码。
- 所有敏感信息只保存在本机内存。

如果 Android App 自己要提供 VPN 连接能力，需要后续接入 Android `VpnService`。如果只是生成配置给其他客户端使用，第一版不需要实现 VPN 内核。

## 第二阶段：增强能力

- Android Keystore：保存用户允许保存的非敏感偏好。
- Windows Credential Manager：保存用户明确允许保存的非敏感偏好。
- 本地文件导出：配置、报告、二维码图片。
- SSH 部署模块：命令执行前展示并确认。
- 离线二维码生成。
- 一键清除本地敏感数据。

## 第三阶段：正式产品

- Windows 安装包签名。
- Android APK/AAB 打包。
- 隐私政策。
- 本地日志脱敏审计。
- 协议兼容性测试。
- 自动化端到端测试。

## 多端架构

```text
shared core
  ├─ 脱敏规则
  ├─ 协议推荐逻辑
  ├─ UUID / key / shortId 生成
  ├─ 客户端配置生成
  └─ 安全报告生成

apps
  ├─ web preview
  ├─ windows shell
  └─ android shell
```

## 隐私边界

Windows 和 Android 版本都必须继续遵守：

- 不上传 VPS IP。
- 不上传 SSH 密码。
- 不上传私钥、UUID、Reality privateKey、shortId。
- 不调用在线订阅转换服务。
- 日志默认脱敏。
- 命令执行前必须给用户确认。
- 用户可以一键清除本地敏感数据。

## 推荐执行顺序

1. 先把当前 Web MVP 打包成 Windows Tauri App。
2. 再把同一套 Web 核心打包成 Android WebView/Capacitor App。
3. 加本地导出和二维码。
4. 加 SSH 自动部署。
5. 最后考虑内置 VPN 连接能力。
