# 边缘函数

把 API 请求搬到边缘节点处理，减少回源量和响应延迟。

## 能干嘛

- 读取接口（配置、历史时间线、历史健康数据、历史位置轨迹、历史公开留言）在边缘缓存，不用每次都回源
- 公开留言按 `slot` URL 分片缓存；当前窗口不缓存，历史窗口可由 CDN 按 URL 命中
- 缓存响应会写入 ESA 默认标签头 `Cache-Tag`，便于按标签刷新 CDN；同时保留 `ESA-Cache-Tag` 兼容别名，但默认刷新以 `Cache-Tag` 为准
- PoW 挑战在边缘生成和验证，不走 CDN。当前使用 HMAC 签名并绑定 `sha256(fingerprint)` 的 Hashcash v2：客户端完成 nonce 计算，边缘只做验签、过期检查和一次 SHA-256，避免边缘 CPU 被 `/api/token/issue` 拖满
- 无效的访客 token 请求会在边缘直接拒绝，公开/私聊留言 POST 也会先做边缘 token 校验和限流
- 边缘函数会为所有自身返回和回源响应补齐安全头与 CORS 头；跨域敏感接口仍需要在 EdgeKV 配置 `cors_allowed_origins`

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
| `cors_allowed_origins` | 可选。敏感接口跨域允许来源，逗号/空白分隔；需要和源站 `CORS_ALLOWED_ORIGINS` 保持一致。公开读取、PoW 和 token 签发接口仍使用 `Access-Control-Allow-Origin: *` |

配置 `device_tokens` 或 `device_token_hashes` 后，带有效 `Authorization: Bearer <token>` 的设备/API 管理请求会在边缘直接签名回源，不走访客 token 校验，也不吃边缘全局 IP 限流。`/api/report`、`/api/health-data`、设备消息接口、AI 总结设置、AI 端点/Key 配置与手动刷新接口都按这个路径处理，手表端 Zepp 令牌同样可通过；源站仍会继续校验设备密钥。`/api/ai-config` 的 AI Key payload 在 App 和源站之间端到端密封，边缘函数只鉴权、签名穿透和补 no-store/Cache-Tag，不解密也不缓存密文内容。

公开留言读取 `GET /api/messages/public` 是公开读取接口，不需要访客 token；发布公开留言、私聊、订阅推送等写入接口仍需要访客 token，并会在边缘先验证再回源。

### 4. 配置路由

函数路由 → 添加一条规则。当前线上验证中，WebSocket Upgrade 经过边缘函数会返回 504，因此默认排除 `/api/ws`：

```
(http.host in {"live.myallinone.online"} and not lower(http.request.uri.path) contains "/api/ws" and lower(http.request.uri.path) contains "/api/")
```

这种模式下 WS 直达源站；源站仍会验证设备/访客 token，并有 IP、viewer 重连频率和总连接数限制。

如果你的 ESA 配置确认 WebSocket Upgrade 可以穿过边缘函数，可以覆盖全部 `/api/*`：

```
(http.host in {"live.myallinone.online"} and lower(http.request.uri.path) contains "/api/")
```

此时 `/api/ws` 会先在边缘验证设备 token 或访客 token，再穿透到源站，源站仍会二次校验 token 和连接限流。

## 源站要改什么

`HASH_SECRET` 必须和 EdgeKV 里的 `secret` 保持一致。源站会自动识别带有效 HMAC 的边缘请求；即使开启 `EDGE_MODE=true`，未签名的直连源站请求仍会走源站 PoW/JA4 校验。

如果源站公网可达，建议同时开启：

```
EDGE_MODE=true
REQUIRE_EDGE=true
```

`REQUIRE_EDGE` 会拒绝没有 `X-Edge-Internal` HMAC 的普通 API 直连请求；`/api/ws` 仍由设备/访客 token、连接数和重连限流保护。

## 安全

- 边缘函数和服务器之间用 HMAC 签名验证，伪造的请求会被拒绝
- `HASH_SECRET` 存在 EdgeKV 里，不在代码中
- 内部请求用 HMAC 签名防循环，外部无法伪造
- PoW、访客 token、访客写入和 WS 等保护路径在边缘异常时 fail-closed，不会签名回源绕过源站保护

## 限流

| 类型 | 限制 |
|------|------|
| 全局 IP | 300/min |
| PoW 挑战 | 30/min |
| Token 签发 | 12/min |
| 已登录用户 | 60/min |

PoW 使用 `difficultyBits=17` 的 bit 级 Hashcash，并要求 `/api/pow/challenge` 携带 `fp_hash=sha256(fingerprint)`。旧版 16K SHA-256 链需要边缘完整重算，属于客户端/边缘对称成本；新版客户端预期工作量不低于旧版，但边缘验证是常数级，能避免刷新时 `/api/token/issue` 因 CPU 超限失败。

ESA Fetch/Cache 子请求预算按次计数，缓存读取路径会优先保留 `config + cache.get + fetch + cache.put` 的 4 次预算。`/api/token/issue` 不再在边缘做额外访客身份 KV 合并，只按浏览器指纹稳定派生 viewer id；同一浏览器不同 IP 仍会合并，同 IP 不同浏览器指纹的进一步合并交给源站路径/后续持久化策略处理，避免边缘签发超出子请求限制。

## 缓存标签

阿里云 ESA 的默认标签头是 `Cache-Tag`。本项目源站和边缘函数都会输出默认 `Cache-Tag`；`ESA-Cache-Tag` 只是兼容别名，未自定义缓存标签名称时按标签刷新应提交 `Cache-Tag` 里的标签值：

| Header | 用途 |
|--------|------|
| `Cache-Tag` | ESA 默认缓存标签头 |
| `ESA-Cache-Tag` | 显式 ESA 标签头别名 |

目前标签覆盖：

| 接口 | 标签 |
|------|------|
| `/` / HTML fallback | `page`, `page-index` |
| `/_next/*`、`/icon.svg`、`/favicon.ico` 等静态资源 | `static`, `static-<path>`，例如 `static-favicon-ico` |
| `/api/current` | `current`, `realtime`, `status` |
| `/api/timeline?date=YYYY-MM-DD` | `timeline`, `timeline-YYYY-MM-DD`，带 `window` 时追加 `timeline-window-YYYYMMDDHH`，带 `device_id` 时追加 `timeline-device-<device_id>` |
| `/api/health-data?date=YYYY-MM-DD` | `health-data`, `health-data-summary`/`health-data-full`, `health-data-YYYY-MM-DD`，带 `window` 时追加 `health-data-window-YYYYMMDDHH`，带 `device_id` 时追加 `health-device-<device_id>` |
| `/api/location?date=YYYY-MM-DD` | `location`, `location-YYYY-MM-DD`，带 `window` 时追加 `location-window-YYYYMMDDHH`，带 `device_id` 时追加 `location-device-<device_id>` |
| `/api/messages/public?recent=1` | `public-messages`, `public-messages-recent` |
| `/api/messages/public?slot=YYYYMMDDHHmm` | `public-messages`, `public-messages-slot-YYYYMMDDHHmm` |
| `/api/messages/public?window=YYYYMMDDHH` | `public-messages`, `public-messages-YYYYMMDDHH` |
| `/api/config` | `config` |
| `/api/health` | `health` |
| `/api/daily-summary` | `daily-summary`, `daily-summary-<date 或 current>` |
| `/api/weekly-summary` | `weekly-summary`, `weekly-summary-<week_start/date 或 current>` |
| `/api/summary-settings` | `summary-settings`，不缓存 |
| `/api/ai-config` | `ai-config`，不缓存 |

当前状态、当前/上一小时的时间线、当天健康数据、当前/上一小时的位置轨迹、当前公开留言窗口和 WebSocket 不缓存，避免在线状态/时间线/健康/留言/位置显示滞后。更早的同日时间线/位置和历史健康数据按小时窗口缓存，例如 `window=2026060201`；当天健康数据可能由手表延迟补发到过去的小时窗口，因此当天健康窗口也保持不缓存。源站对实时响应也会带 `Cache-Control: no-store`、`CDN-Cache-Control: no-store`、`Expires: 0`，并继续输出对应的 `Cache-Tag`，便于 ESA 规则误缓存后按标签清理。

按标签刷新可使用这些标签：`page`、`static`、`current`、`realtime`、`status`、`timeline`、`timeline-YYYY-MM-DD`、`timeline-window-YYYYMMDDHH`、`health-data`、`health-data-summary`、`health-data-full`、`health-data-YYYY-MM-DD`、`health-data-window-YYYYMMDDHH`、`location`、`location-YYYY-MM-DD`、`location-window-YYYYMMDDHH`、`public-messages`、`public-messages-recent`、`public-messages-slot-YYYYMMDDHHmm`、`public-messages-YYYYMMDDHH`、`daily-summary`、`daily-summary-YYYY-MM-DD`、`weekly-summary`、`weekly-summary-YYYY-MM-DD`、`summary-settings`、`ai-config`。ESA 默认标签头仍是 `Cache-Tag`。

## HASH_SECRET 要求

- hex 字符串，32-128 位
- 生成：`openssl rand -hex 32`
- 源站和 EdgeKV 里必须是同一个值

## 注意

- EdgeKV 全球分布，同步有几秒延迟
- 单次执行最多 10 秒
- 代码包最大 4MB
