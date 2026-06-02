# 边缘函数

把 API 请求搬到边缘节点处理，减少回源量和响应延迟。

## 能干嘛

- 读取接口（配置、历史时间线、历史健康数据、历史位置轨迹、历史公开留言）在边缘缓存，不用每次都回源
- 公开留言按 `slot` URL 分片缓存；当前窗口不缓存，历史窗口可由 CDN 按 URL 命中
- 缓存响应会同时写入 `Cache-Tag` 和 `ESA-Cache-Tag`，便于按标签刷新 CDN
- PoW 挑战在边缘生成和验证，不走 CDN
- 无效的访客 token 请求会在边缘直接拒绝，公开/私聊留言 POST 也会先做边缘 token 校验和限流

## 部署（阿里云 ESA）

ESA 不支持环境变量，配置存在 EdgeKV 里。

### 1. 创建函数

[ESA 控制台](https://esa.console.aliyun.com/) → 边缘计算 → 函数和Pages → 创建函数 → 粘贴 `edge-router.js`

### 2. 创建 EdgeKV 命名空间

边缘存储 → 创建两个命名空间：
- `live-dashboard-config` — 存配置
- `live-dashboard` — 运行时数据（PoW 挑战、限流计数）

### 3. 写入配置

在 `live-dashboard-config` 命名空间写入：

| Key | 值 |
|-----|---|
| `origin` | `https://live.myallinone.online`（你的域名/加速域名） |
| `secret` | 和服务器 `.env` 的 `HASH_SECRET` 一样 |
| `device_tokens` | 可选。设备密钥白名单，逗号/空白分隔；也兼容 `token:device_id:name:platform` 这种服务端配置行 |
| `device_token_hashes` | 可选。`HMAC-SHA256(secret, "device:" + token)` 的 hex 列表，适合不想在 EdgeKV 存明文密钥 |

配置 `device_tokens` 或 `device_token_hashes` 后，带有效 `Authorization: Bearer <token>` 的设备/API 管理请求会在边缘直接签名回源，不走访客 token 校验，也不吃边缘全局 IP 限流。`/api/report`、`/api/health-data` 和设备消息接口都按这个路径处理，手表端 Zepp 令牌同样可通过；源站仍会继续校验设备密钥。

### 4. 配置路由

函数路由 → 添加一条规则：

```
(http.host in {"live.myallinone.online"} and not lower(http.request.uri.path) contains "/api/ws" and lower(http.request.uri.path) contains "/api/")
```

这条规则把所有 `/api/*` 请求路由到边缘函数，但排除 `/api/ws`（WebSocket）。

**为什么排除 WS**：ESA 的 `upgrade` 头在黑名单里，WS 请求经过边缘函数会直接失败，必须直达源站。

## 源站要改什么

不用改。源站自动识别边缘请求，`HASH_SECRET` 保持一致就行。

## 安全

- 边缘函数和服务器之间用 HMAC 签名验证，伪造的请求会被拒绝
- `HASH_SECRET` 存在 EdgeKV 里，不在代码中
- 内部请求用 HMAC 签名防循环，外部无法伪造

## 限流

| 类型 | 限制 |
|------|------|
| 全局 IP | 300/min |
| PoW 挑战 | 30/min |
| Token 签发 | 12/min |
| 已登录用户 | 60/min |

## 缓存标签

阿里云 ESA 的默认标签头是 `Cache-Tag`。为了兼容控制台/规则里可能使用的 ESA 命名，本项目源站和边缘函数会同时输出：

| Header | 用途 |
|--------|------|
| `Cache-Tag` | ESA 默认缓存标签头 |
| `ESA-Cache-Tag` | 显式 ESA 标签头别名 |

目前标签覆盖：

| 接口 | 标签 |
|------|------|
| `/api/timeline?date=YYYY-MM-DD` | `timeline`, `timeline-YYYY-MM-DD`，带 `device_id` 时追加 `timeline-device-<device_id>` |
| `/api/health-data?date=YYYY-MM-DD` | `health-data`, `health-data-YYYY-MM-DD`，带 `device_id` 时追加 `health-device-<device_id>` |
| `/api/location?date=YYYY-MM-DD` | `location`, `location-YYYY-MM-DD`，带 `device_id` 时追加 `location-device-<device_id>` |
| `/api/messages/public?slot=YYYYMMDDHHmm` | `public-messages`, `public-messages-slot-YYYYMMDDHHmm` |
| `/api/messages/public?window=YYYYMMDDHH` | `public-messages`, `public-messages-YYYYMMDDHH` |
| `/api/config` | `config` |
| `/api/health` | `health` |
| `/api/daily-summary` | `daily-summary`, `daily-summary-<date 或 current>` |

当前状态、当前/上一小时的时间线、健康数据、位置轨迹、当前公开留言窗口和 WebSocket 不缓存，避免在线状态/时间线/健康/留言/位置显示滞后。更早的同日数据按小时窗口缓存，例如 `window=2026060201`；这样页面轮询时只会穿透实时小时窗口，已稳定的历史小时由浏览器/CDN 承担。源站对实时响应也会带 `Cache-Control: no-store`、`CDN-Cache-Control: no-store`、`Expires: 0`，并继续输出对应的 `Cache-Tag`，便于 ESA 规则误缓存后按标签清理。

按标签刷新可使用这些标签：`timeline`、`timeline-YYYY-MM-DD`、`timeline-window-YYYYMMDDHH`、`health-data`、`health-data-YYYY-MM-DD`、`health-data-window-YYYYMMDDHH`、`location`、`location-YYYY-MM-DD`、`location-window-YYYYMMDDHH`、`public-messages-slot-YYYYMMDDHHmm`。ESA 默认标签头仍是 `Cache-Tag`。

## HASH_SECRET 要求

- hex 字符串，32-128 位
- 生成：`openssl rand -hex 32`
- 源站和 EdgeKV 里必须是同一个值

## 注意

- EdgeKV 全球分布，同步有几秒延迟
- 单次执行最多 10 秒
- 代码包最大 4MB
