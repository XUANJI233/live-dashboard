# ESA Edge Functions — Live Dashboard 边缘计算层

## 架构概览

```
浏览器 → ESA 边缘函数（V8 Isolate） → 源站（仅必要时回源）
              │
              ├── PoW 挑战/验证 → Edge KV（彻底解决 CDN 缓存问题）
              ├── 读取端点缓存 → Cache API（/api/current 3s, /api/timeline 10s）
              ├── Token 验证 → WebCrypto HMAC（无效请求不回源）
              └── 写入请求 → 限流后穿透到源站
```

## 端点处理策略

| 端点 | 策略 | 缓存 TTL | 说明 |
|------|------|---------|------|
| `GET /api/pow/challenge` | **边缘处理** | - | Edge KV 存储挑战，不再受 CDN 缓存影响 |
| `POST /api/token/issue` | **边缘处理** | - | 边缘验证 PoW + 签发 token |
| `GET /api/current` | Cache API | 3s | 设备状态，高频访问 |
| `GET /api/timeline` | Cache API | 10s | 时间线数据 |
| `GET /api/config` | Cache API | 60s | 站点配置，很少变化 |
| `GET /api/messages/public` | Cache API | 10s | 公开留言 |
| `GET /api/health` | Cache API | 5s | 健康检查 |
| `GET /api/health-data` | 边缘验证 + 穿透 | - | 需要 viewer token |
| `GET /api/location` | 边缘验证 + 穿透 | - | 需要 viewer token |
| `GET /api/ws` | 穿透 | - | WebSocket 直连源站 |
| `POST /api/report` | 穿透 | - | 设备上报 |

## 部署步骤

### 1. 在 ESA 控制台创建边缘函数

1. 登录 [阿里云 ESA 控制台](https://esa.console.aliyun.com/)
2. 进入 **边缘函数** → **创建函数**
3. 函数名称: `live-dashboard-edge`
4. 上传 `edge-router.js` 的代码

### 2. 配置环境变量

在 ESA 函数配置中设置：

| 变量 | 值 | 说明 |
|------|---|------|
| `ORIGIN_URL` | `http://172.20.0.80:3000` | 源站内网地址 |
| `HASH_SECRET` | 与源站一致的 HMAC 密钥 | 用于 token 签名/验证 |
| `EDGE_KV_NAMESPACE` | `live-dashboard` | Edge KV 命名空间 |

### 3. 创建 Edge KV 命名空间

1. 在 ESA 控制台 → **边缘存储** → **创建命名空间**
2. 名称: `live-dashboard`
3. 用于存储 PoW 挑战和频率限制

### 4. 配置路由规则

在 ESA 控制台 → **函数路由** 中添加：

| 路由 | 函数 | 说明 |
|------|------|------|
| `live.myallinone.online/api/*` | `live-dashboard-edge` | 所有 API 走边缘函数 |
| `live.myallinone.online` | (静态资源) | 前端页面走 Pages/CDN |

### 5. 源站配置

在源站的 `.env` 或 docker-compose 中添加：

```bash
EDGE_MODE=true
```

这会让源站：
- 跳过 PoW 挑战生成（由边缘处理）
- 跳过 PoW 验证（由边缘处理）
- 信任 `X-Edge-Verified` 和 `X-Edge-Viewer-Id` 头

### 6. 验证部署

```bash
# 测试 PoW 挑战（应该不再被 CDN 缓存）
curl -s "https://live.myallinone.online/api/pow/challenge" | jq .

# 检查响应头是否有 X-Edge-Cache
curl -sI "https://live.myallinone.online/api/current" | grep X-Edge-Cache
```

## 效果预期

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| PoW 403 错误 | 100%（CDN 缓存） | 0%（边缘生成） |
| `/api/current` 回源 | 每次 | 每 3 秒最多 1 次/边缘节点 |
| `/api/timeline` 回源 | 每次 | 每 10 秒最多 1 次/边缘节点 |
| Token 验证回源 | 每次 | 仅首次 + token 过期时 |
| 源站 QPS | ~100% | 降低 80-90% |

## 代码结构

```
edge-functions/
├── edge-router.js      # 主入口：路由分发、PoW、缓存、验证
└── README.md           # 本文件
```

## 注意事项

- **Edge KV 延迟**: Edge KV 是全球分布的，写入后可能存在短暂不一致（最终一致性）
- **Cache API 限制**: Cache API 的 `put`+`get`+`delete` 与 `fetch` 共享子请求限制（默认 32 个）
- **网关超时**: ESA 边缘函数网关超时 10 秒，如果源站响应慢会返回 504
- **代码包大小**: 单个函数代码上限 4MB
