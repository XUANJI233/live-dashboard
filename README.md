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
| `EDGE_MODE` | `false` | 边缘函数/CDN 模式（跳过源站 PoW/JA4） |
| `NSFW_FILTER_DISABLED` | `false` | 禁用 NSFW 过滤 |
| `POW_DISABLED` | `false` | 禁用 PoW 验证（不推荐） |
| `TLS_CHECK_DISABLED` | `false` | 禁用 TLS 检查（不推荐） |
| `MESSAGE_BOARD_ENABLED` | `true` | 留言板 |
| `PRIVATE_CHAT_ENABLED` | `true` | 私聊功能 |
| `CORS_ALLOWED_ORIGINS` | 空 | CORS 允许的域名，逗号分隔 |
| `AI_API_URL` | 空 | AI 每日总结 API 地址 |
| `AI_API_KEY` | 空 | AI API 密钥 |
| `AI_MODEL` | `gpt-4o-mini` | AI 模型名称 |

AI 总结支持日总结和周总结。`GET /api/daily-summary`、`GET /api/weekly-summary` 可公开读取缓存结果；`POST /api/daily-summary`、`POST /api/weekly-summary` 会强制重新生成，`GET/POST /api/summary-settings` 用于读取和保存总结模式（温和/一般/锐评）与近期目标，这些管理接口都需要 `DEVICE_TOKEN_*` Bearer token。`AI_API_URL` / `AI_API_KEY` 环境变量优先级最高；如果服务器没有设置环境变量，Android App 可通过 `GET/POST /api/ai-config` 配置 AI 端点、Key 和模型。AI Key 上传使用服务端 X25519 公钥协商、HKDF-SHA256、AES-256-GCM 加密，并用设备 token 做 HMAC-SHA256 签名；如果服务器已有环境变量，接口会返回锁定提示并拒绝覆盖。

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
