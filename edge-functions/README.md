# 边缘函数

把 API 请求搬到边缘节点处理，减少回源量和响应延迟。

## 能干嘛

- 读取接口（设备状态、时间线、配置）在边缘缓存几秒，不用每次都回源
- PoW 挑战在边缘生成和验证，不走 CDN
- 无效的 token 请求在边缘直接拒绝，不打到服务器

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

## HASH_SECRET 要求

- hex 字符串，32-128 位
- 生成：`openssl rand -hex 32`
- 源站和 EdgeKV 里必须是同一个值

## 注意

- EdgeKV 全球分布，同步有几秒延迟
- 单次执行最多 10 秒
- 代码包最大 4MB