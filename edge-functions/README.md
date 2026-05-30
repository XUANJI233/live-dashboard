# 边缘函数

把 API 请求搬到边缘节点处理，减少回源量和响应延迟。支持阿里云 ESA 和腾讯云 EdgeOne。

## 能干嘛

读取接口（设备状态、时间线、配置）在边缘缓存几秒，不用每次都回源。PoW 挑战也在边缘处理。无效的 token 请求直接在边缘拒绝，不打到服务器。

## 部署（ESA）

[ESA 控制台](https://esa.console.aliyun.com/) → 边缘计算 → 函数和Pages → 创建函数 → 粘贴 `edge-router.js`

环境变量：

| 变量 | 值 |
|------|---|
| `ORIGIN_URL` | `http://你的服务器IP:3000` |
| `HASH_SECRET` | 和服务器 `.env` 里的 `HASH_SECRET` 一样 |
| `EDGE_KV_NAMESPACE` | `live-dashboard` |

然后：
- 边缘存储 → 创建命名空间 `live-dashboard`
- 函数路由 → 添加 `你的域名/api/*` → 选这个函数

## 部署（EdgeOne）

[EdgeOne 控制台](https://console.cloud.tencent.com/edgeone) → 边缘函数 → 创建 → 粘贴代码

环境变量同上。KV 存储创建命名空间 `live-dashboard`。触发规则添加 `你的域名/api/*`。

EdgeOne CPU 限制 200ms，PoW 的 SHA-256 计算可能超时，其他功能正常。

## 源站要改什么

不用改。源站自动识别边缘请求，`HASH_SECRET` 保持一致就行。

## HASH_SECRET 要求

- 必须是 hex 字符串，32-128 位
- 生成：`openssl rand -hex 32`
- 源站和边缘函数必须用同一个值

## 安全

边缘函数和服务器之间用 HMAC 签名验证，伪造的请求会被拒绝。密钥通过环境变量配置，不在代码里。

## 限流

| 类型 | 限制 |
|------|------|
| 全局 IP | 300/min |
| PoW 挑战 | 30/min |
| Token 签发 | 12/min |
| 已登录用户 | 60/min |

## 注意

- 边缘存储全球分布，同步有几秒延迟
- 单次执行最多 10 秒
- 代码包最大 4MB
- 代码包最大 4MB
