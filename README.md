# Live Dashboard

实时设备活动仪表盘 — 公开展示你正在使用的应用，拥有二次元风格 UI 和隐私优先设计。

在线演示：https://now.monikadream.homes/

## 截图

**日间模式（设备在线）**

![日间模式](docs/preview-main-light.png)

**夜间模式（设备离线）**

![夜间模式](docs/preview-main-dark.png)

## 特色

- 猫耳装饰的视觉小说风格对话框 + 中文戏剧化活动描述
- 飘落的樱花花瓣动画，夜间自动切换萤火主题
- 三级隐私系统（SHOW / BROWSER / HIDE）保护敏感窗口标题
- 系统托盘常驻 + AFK 检测（看视频/听歌时自动豁免）
- 音乐检测（Spotify、QQ音乐、网易云等）
- Health Connect 健康数据同步（Android）
- 多设备多平台支持（Windows / macOS / Android）

## 快速开始

```bash
# 1. 生成密钥
TOKEN=$(openssl rand -hex 16)
SECRET=$(openssl rand -hex 32)

# 2. 启动
docker run -d --name live-dashboard \
  -p 3000:3000 \
  -v dashboard_data:/data \
  -e HASH_SECRET=$SECRET \
  -e DEVICE_TOKEN_1=$TOKEN:my-pc:MyPC:windows \
  ghcr.io/monika-dream/live-dashboard:latest

# 3. 打开 http://localhost:3000
echo "Token: $TOKEN  ← Agent 配置用"
```

详细部署说明（docker-compose、VPS + Nginx + HTTPS）见 [Wiki - 快速部署](https://github.com/Monika-Dream/live-dashboard/wiki/快速部署)。

## Agent 下载

从 [GitHub Releases](https://github.com/Monika-Dream/live-dashboard/releases) 下载对应平台的客户端：

| 平台 | 下载文件 | 配置指南 |
|------|---------|---------|
| Windows | `live-dashboard-agent.exe` | [Wiki - Windows Agent](https://github.com/Monika-Dream/live-dashboard/wiki/Agent-配置-Windows) |
| macOS | `live-dashboard-agent-macos.zip` | [Wiki - macOS Agent](https://github.com/Monika-Dream/live-dashboard/wiki/Agent-配置-macOS) |
| Android | `live-dashboard.apk` | [Wiki - Android App](https://github.com/Monika-Dream/live-dashboard/wiki/Agent-配置-Android) |

## 主题

| 分支 | 风格 | 说明 |
|------|------|------|
| `main` | 经典和风 | 暖粉色系、猫耳气泡框、樱花花瓣 |
| `redesign/blossom-letter` | 花信 · 文艺书卷 | OKLCH 暖纸色、双栏布局、AI 每日总结 |
| `redesign/pixel-room` | 像素房间 | 像素风 + 日夜切换（开发中） |

## 分支结构

| 分支 | 内容 |
|------|------|
| `main` | 后端 + 前端 + Docker + CI |
| `windows-source` | Windows Agent 源码（Python） |
| `macos-source` | macOS Agent 源码（Python） |
| `android-source` | Android App 源码（Kotlin） |

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Bun + TypeScript + SQLite |
| 前端 | Next.js 15 + React 19 + Tailwind CSS 4（静态导出） |
| Windows Agent | Python + Win32 API + pystray + pycaw |
| macOS Agent | Python + AppleScript + pystray |
| Android App | Kotlin + Jetpack Compose + Health Connect |
| 部署 | Docker 多阶段构建 + Nginx |
| 边缘计算 | ESA Edge Functions（PoW 边缘处理 + 读取缓存） |

### CDN 缓存标签

阿里云 ESA 默认读取的缓存标签头是 `Cache-Tag`；源站和边缘函数会同时输出 `Cache-Tag` 与 `ESA-Cache-Tag`，因此默认标签刷新和自定义标签头两种配置都能命中。首页 HTML 使用 `page/page-index` 标签且不缓存，静态资源使用 `static/static-<path>` 标签；当前状态、当前/上一小时的时间线、当天健康数据、当前/上一小时的位置轨迹、当前公开留言窗口和 WebSocket 不缓存；更早的同日时间线/位置和历史健康数据按小时窗口缓存并带 `timeline-window-YYYYMMDDHH`、`health-data-summary`/`health-data-full`、`health-data-window-YYYYMMDDHH`、`location-window-YYYYMMDDHH` 等标签，历史时间线、历史健康数据、历史位置轨迹、历史公开留言、配置、健康检查、每日总结、周总结也会带标签，便于在 CDN 控制台按标签刷新。AI 总结设置与手动刷新接口不缓存。当天健康数据可能由手表延迟补发到过去的小时窗口，因此当天健康窗口也保持不缓存。

## 环境变量

### 必填

| 变量 | 说明 | 示例 |
|------|------|------|
| `HASH_SECRET` | HMAC 签名密钥，≥64 位 hex | `openssl rand -hex 32` |
| `DEVICE_TOKEN_1` | 设备令牌，格式: `密钥:设备ID:显示名:平台` | `openssl rand -hex 16 \| xargs -I{} echo "{}:my-pc:我的电脑:windows"` |

平台可选: `windows` / `android` / `macos` / `zepp`

### 可选

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DEVICE_TOKEN_X` | - | 第X个设备令牌，格式同上 |
| `DISPLAY_NAME` | 空 | 站点显示名称 |
| `SITE_TITLE` | 空 | HTML 标题 |
| `SITE_DESC` | 空 | HTML meta 描述 |
| `SITE_FAVICON` | 空 | 自定义 favicon 路径 |
| `CDN_MODE` | `true` | CDN 加速模式 |
| `EDGE_MODE` | `false` | 边缘函数/CDN 模式；只有带有效边缘 HMAC 的请求才会跳过源站 PoW/JA4 |
| `REQUIRE_EDGE` | `false` | API 源站只接受边缘函数签名请求（公网源站建议开启；WS 仍由自身 token 校验） |
| `NSFW_FILTER_DISABLED` | `false` | 禁用 NSFW 过滤 |
| `POW_DISABLED` | `false` | 禁用 PoW 验证（不推荐） |
| `TLS_CHECK_DISABLED` | `false` | 禁用 TLS 检查（不推荐） |
| `MESSAGE_BOARD_ENABLED` | `true` | 留言板 |
| `PRIVATE_CHAT_ENABLED` | `true` | 私聊功能 |
| `CORS_ALLOWED_ORIGINS` | 空 | CORS 允许的域名，逗号分隔 |
| `AI_API_URL` | 空 | AI 每日总结 API 地址 |
| `AI_API_KEY` | 空 | AI API 密钥 |
| `AI_MODEL` | `gpt-4o-mini` | AI 模型名称 |
| `AI_DEBUG_LOG` | `false` | 设置为 `true` 时输出 AI 总结/监督请求与回复调试日志 |

AI 总结支持日总结和周总结。`GET /api/daily-summary`、`GET /api/weekly-summary` 可公开读取缓存结果；`POST /api/daily-summary`、`POST /api/weekly-summary` 会强制重新生成，`GET/POST /api/summary-settings` 用于读取和保存总结模式（温和/一般/锐评）、通用目标、计划休息、每周 7 天目标计划、日总结时间和周总结星期/时间，这些管理接口都需要 `DEVICE_TOKEN_*` Bearer token。日总结会把当前日期、星期几、当天时间线、前两天时间线和前两天 AI 评价一起发给 AI；周总结会发送 7 天完整时间线、7 天目标计划和 7 天 AI 评价。AI 返回内容按不可信输入处理，只保留安全 Markdown 子集，清理 HTML、代码块、链接、命令、脚本和控制字符后保存。服务端使用 Vercel AI SDK 的 OpenAI-compatible provider 发起非流式文本生成。

自动总结由服务端定时器读取 `summary-settings` 触发生成；当前只负责写入服务端缓存。管理员 App 尚未实现可接收 AI 总结主动推送的订阅通道，因此不会假装“已推送到 App”。

`AI_API_URL` / `AI_API_KEY` 环境变量优先级最高；如果服务器没有设置环境变量，Android App 可通过 `GET/POST /api/ai-config` 配置 AI 端点、Key 和模型，保存前可调用 `POST /api/ai-config/test` 加密试连并获取模型列表。AI Key 上传使用 v2 密封 payload：服务端 X25519 公钥、客户端临时 X25519 密钥、HKDF-SHA256、AES-256-GCM，并把当前服务端公钥写入 HKDF transcript 和 GCM AAD；设备 token 只用于管理员鉴权和 HMAC-SHA256 payload 签名。如果服务器已有环境变量，接口会返回锁定提示并拒绝覆盖。

App 管理的 AI 配置会存进 SQLite `meta` 表：`ai_runtime_config` 保存 AI 端点、Key、模型，`ai_curve25519_keypair` 保存服务端 X25519 密钥对。两者都用 `HASH_SECRET` 经 HKDF-SHA256 按 meta key 分离派生 AES-256-GCM key 后密封保存；源站读取时再解封。AI API URL 必须是 HTTPS，且不能包含用户名、密码、query 或 fragment，避免把密钥藏进 URL。

需要排查 AI 请求时可临时设置 `AI_DEBUG_LOG=true`。日志会输出日/周总结、监督规则和监督复核的 messages、模型参数、原始回复、清洗/解析结果与错误；API Key、Authorization、签名、密文和 token 字段会被遮蔽。

### 边缘函数配置

边缘函数配置存在 EdgeKV 里（ESA 不支持环境变量）：

| Key | 说明 |
|-----|------|
| `origin` | 源站地址，如 `https://live.myallinone.online` |
| `secret` | 和服务器 `HASH_SECRET` 一样 |

详见 [edge-functions/README.md](edge-functions/README.md)。

## 文档

完整文档见 [GitHub Wiki](https://github.com/Monika-Dream/live-dashboard/wiki)：

- [快速部署](https://github.com/Monika-Dream/live-dashboard/wiki/快速部署) — Docker 一键部署
- [VPS 部署指南](https://github.com/Monika-Dream/live-dashboard/wiki/VPS-部署指南) — Nginx + HTTPS
- [功能特性](https://github.com/Monika-Dream/live-dashboard/wiki/功能特性) — 完整功能列表
- [架构与项目结构](https://github.com/Monika-Dream/live-dashboard/wiki/架构与项目结构) — 架构图 + 项目树
- [隐私分级系统](https://github.com/Monika-Dream/live-dashboard/wiki/隐私分级系统) — SHOW / BROWSER / HIDE
- [API 参考](https://github.com/Monika-Dream/live-dashboard/wiki/API-参考) — 端点、请求体、响应格式
- [环境变量](https://github.com/Monika-Dream/live-dashboard/wiki/环境变量) — 配置项一览
- [安全设计](https://github.com/Monika-Dream/live-dashboard/wiki/安全设计) — 安全特性
- [边缘计算](edge-functions/README.md) — ESA 边缘函数部署指南
- [自定义](https://github.com/Monika-Dream/live-dashboard/wiki/自定义) — 显示名、元数据、主题色
- [本地开发](https://github.com/Monika-Dream/live-dashboard/wiki/本地开发) — 从源码构建

## 许可证

MIT
