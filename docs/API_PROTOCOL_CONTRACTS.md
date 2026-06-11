# API Protocol Contracts

更新时间：2026-06-11

本文档记录服务端、Edge Function、Web 前端、Android 普通端、Android LSP、Windows/macOS Agent 之间共享的固定字段、ID、Header 和帧类型。新增或修改通道时先更新这里，再改代码和测试。

## 命名规则

- JSON 字段统一使用 `snake_case`。不要新增 `camelCase` 同义字段。
- 配置和能力开关必须是真布尔 `true` / `false`。不要用 `0` / `1`、`"true"` / `"false"`。
- 时间字段使用 ISO 8601 UTC 字符串，例如 `2026-06-11T10:00:00.000Z`。面向 AI 的本地时间可以另附文本，但机器字段仍保留 UTC。
- ID 字段使用 ASCII 安全集合 `[a-zA-Z0-9_.:-]`，服务端会裁剪和校验。不要把自然语言说明塞进 ID。
- 同一含义只允许一个字段名。特别是不要把 `device_id` 写成 `client_id`，不要把 `request_id` 写成 `job_id`。

## 固定 Header

| Header | 方向 | 含义 |
| --- | --- | --- |
| `Authorization: Bearer <device_token>` | 设备/管理端 -> Edge/源站 | 设备、管理、AI job、消息和上报鉴权。 |
| `Content-Type: application/json` | 请求体为 JSON 的 POST/DELETE | 服务端会拒绝非 JSON 的消息写入请求。 |
| `X-Edge-Internal` | Edge -> 源站 | `HASH_SECRET` 对 `edge-internal` 的 HMAC，用于 `REQUIRE_EDGE=true` 的源站直连保护。 |
| `X-Edge-Verified` | Edge -> 源站 | 值为 `true` 时表示 Edge 已验证访客 token。 |
| `X-Edge-Viewer-Id` | Edge -> 源站 | Edge 验证出的 `viewer_id`。 |
| `X-Edge-Signature` | Edge -> 源站 | `HASH_SECRET` 对 `edge:<viewer_id>` 的 HMAC。 |
| `X-Edge-Cache` | Edge -> 浏览器 | 边缘缓存状态调试头。 |
| `Cache-Tag` / `ESA-Cache-Tag` | 源站/Edge -> 浏览器/CDN | ESA 标签刷新使用；两个头保持同值或同语义。 |

## 保留 ID 和哨兵值

| 值 | 所属字段 | 含义 |
| --- | --- | --- |
| `__public__` | `device_id` / `viewer_id` | 公共留言流或公共回复目标。 |
| `__broadcast__` | `device_id` | 服务端历史消息查询中的全设备广播消息。 |
| `__mcp__` | `viewer_id` | MCP/设备命令排队消息的系统来源。 |
| `__supervisor__` | `viewer_id` | Android 消息 UI 中 AI 监督会话，不能拉黑或屏蔽。 |
| `up` | `viewer_name` | 设备/站主对公共留言的回复显示名。 |

## 通用 ID 字段

| 字段 | 唯一含义 |
| --- | --- |
| `device_id` | 设备身份，来自 `DEVICE_TOKEN_*` 配置或设备状态。 |
| `viewer_id` | 访客身份，来自 viewer token；设备侧私聊回复必须带目标 `target_viewer_id`。 |
| `message_id` | 当前访客消息或被回复的原消息 ID。消息发送、删除、ack、错误都用它关联原消息。 |
| `reply_id` | 设备回复自身的消息 ID。设备端可生成，服务端会幂等记录。 |
| `in_reply_to` | 被回复的原 `message_id`。 |
| `request_id` | 一次 AI job 或一次设备命令批次的请求 ID。客户端生成时服务端会校验；服务端可生成 `req_<uuid>`。 |
| `job_request_id` | `ai_request_ack` 中服务端权威 AI job `request_id`。当客户端附着到已有 job 时应切换到它。 |
| `job_key` | 服务端内部 AI job 幂等键，由 `kind + payload` 推导；客户端不应手写依赖。 |
| `command_id` | 单条设备命令 ID，服务端生成 `cmd_<uuid>`，AI/MCP 后续查询命令状态必须用它。 |
| `result_id` | 单条设备执行结果 ID，设备生成或端侧控制器生成 `res_<uuid>`，用于结果幂等。 |
| `status_id` | 设备状态上报 ID，用于 LSP 风险复核 pending 状态的 ack 清除。 |

## WebSocket 入口

- 路径：`/api/ws?role=device` 或 `/api/ws?role=viewer`。
- 设备 WS 必须带 `Authorization: Bearer <device_token>`。
- 访客 WS 必须带 viewer token，可由 Edge 验证后签名回源，也可源站直接验证。
- 服务端连接 ack：
  - 设备：`{ "type": "ack", "status": "connected", "role": "device", "device_id": "..." }`
  - 访客：`{ "type": "ack", "status": "connected", "role": "viewer", "viewer_id": "..." }`

## 访客消息协议

### 访客发送

WS 帧 `viewer_message` 与 HTTP `POST /api/messages/public`、`POST /api/messages/private` 共享字段：

```json
{
  "type": "viewer_message",
  "message_id": "uuid-or-client-id",
  "kind": "public",
  "target_device_id": "android-phone",
  "viewer_name": "visitor",
  "text": "hello"
}
```

- `kind` 只能是 `public` 或 `private`，缺省按 `private`。
- `message_id` 是客户端幂等键；缺省时服务端生成 UUID。
- 私聊必须有 `target_device_id` 和 `text`。
- 公共留言可以带 `target_device_id` 作为优先投递设备，但服务端会广播到支持消息通道的设备。

### 服务端事件

| 帧/响应字段 | 含义 |
| --- | --- |
| `ack.message_id` | 对访客发送的确认，关联原 `message_id`。 |
| `ack.status` | `sent` / `queued` / `recorded`。 |
| `error.message_id` | 发送失败也必须回显原 `message_id`，方便前端释放 waiter。 |
| `public_message.message_id` | 公共留言当前消息 ID。 |
| `viewer_message_sent.message_id` | 私聊消息当前消息 ID；`message.id` 必须相同。 |
| `public_message_deleted.message_id` | 被删除的公共消息 ID。 |
| `message_deleted.message_id` | 被删除的私聊消息 ID。 |
| `viewer_messages_deleted.device_id` | 某设备删除了与该访客的私聊历史。 |

### 投递到设备

设备收到的消息帧：

```json
{
  "type": "viewer_message",
  "message_id": "msg_1",
  "viewer_id": "viewer_1",
  "viewer_name": "visitor",
  "kind": "private",
  "text": "hello",
  "created_at": "2026-06-11T10:00:00.000Z",
  "queued": true,
  "payload": {}
}
```

`payload` 只允许 JSON object，大小上限 4096 bytes。

## 设备回复协议

设备 WS 帧或 HTTP `POST /api/messages/reply`：

```json
{
  "type": "device_reply",
  "message_id": "original_message_id",
  "reply_id": "reply_message_id",
  "target_viewer_id": "viewer_1",
  "text": "已收到"
}
```

- `message_id` 表示被回复的原消息。
- `reply_id` 表示回复自身 ID；缺省时服务端生成 UUID。
- 公共留言回复会保存为 `message_id = "pub_" + reply_id`，响应中 `reply_id` 和 `message_id` 都返回这个公共回复 ID。
- 访客侧收到 `device_reply` 时，`message_id` 是回复自身 ID，`in_reply_to` 是原消息 ID。

## AI Job 协议

长耗时 AI 操作统一走异步 job，避免 Edge Function 8 秒回源超时。

### WS 主路

设备发送：

```json
{
  "type": "ai_request",
  "request_id": "req-client-uuid",
  "kind": "daily_summary",
  "payload": {}
}
```

服务端 ack：

```json
{
  "type": "ai_request_ack",
  "request_id": "req-client-uuid",
  "accepted": true,
  "attached": false,
  "job_request_id": "req-authoritative",
  "job": {}
}
```

- `request_id` 回显客户端请求，用于关联 WS waiter。
- `job_request_id` 是服务端权威 `job.request_id`。如果 `attached=true`，客户端应使用 `job_request_id` 查询和展示。
- 支持的 `kind`：`daily_summary`、`weekly_summary`、`ai_config_test`、`supervision_rules_refresh`。
- 4 秒内没有 `ai_request_ack` 时，客户端用同一 `request_id` 走 HTTP fallback。

### HTTP fallback

- `POST /api/ai-jobs`：同样字段，成功返回 HTTP `202`。
- `GET /api/ai-jobs?request_id=<job_request_id>`：查询状态。
- Job 状态：`queued` / `running` / `succeeded` / `failed`。
- 服务端按 `kind + job_key` 幂等附着，WS 和 HTTP 不应双跑 AI。
- 结果推送帧：`{ "type": "ai_job_update", "job": { ... } }`，推送给支持管理/消息通道的设备 WS。

## 设备命令协议

统一命令 envelope：

```json
{
  "type": "device_command",
  "v": 1,
  "request_id": "req_...",
  "command_id": "cmd_...",
  "created_by": "mcp",
  "target_device_id": "android-phone",
  "issued_at": "2026-06-11T10:00:00.000Z",
  "expires_at": "2026-06-11T10:03:00.000Z",
  "payload": {
    "kind": "supervision",
    "freeze_commands": ["com.example.app"],
    "unfreeze_commands": [],
    "vibrate": true,
    "screen_off": false,
    "say": "回到目标任务",
    "notes": []
  }
}
```

固定字段：

- `v` 当前固定为 `1`。
- `created_by` 只能是 `mcp` 或 `supervision`。
- `payload.kind` 只能是 `supervision` 或 `supervision_policy`。
- `freeze_commands` / `unfreeze_commands` 是应用名或包名正则数组。
- `vibrate` / `screen_off` 必须是真布尔。
- `say` 是设备要展示/播报的话。
- `notes` 是服务端能力裁剪说明，例如 `freeze_not_supported`。

策略命令额外字段：

- `risk_app_regex`：风险应用 AI 复核触发名单。
- `risk_trigger_minutes`：风险名单中任一应用累计使用多少分钟触发 AI 监督。
- `app_time_limits`：独立限时冻结策略，元素为 `{ "app_regex": "...", "limit_minutes": 10, "reason": "..." }`。

命令状态：

- Delivery：`sent` / `queued` / `failed` / `skipped`。
- Receipt：`received` / `rejected` / `missing`。
- Result：`applied` / `partial` / `failed` / `unsupported` / `ignored` / `duplicate` / `expired` / `timeout` / `unknown`。
- 聚合层不能把 WebSocket/HTTP 原始异常直接暴露给 AI，应翻译为上述状态和稳定 `reason`。

## 设备命令回执

设备收到命令后必须回传 receipt，执行后必须回传 result。WS 与 HTTP `/api/supervision/ack` 使用同一 body。

Receipt：

```json
{
  "type": "device_command_receipt",
  "command_id": "cmd_...",
  "request_id": "req_...",
  "status": "received",
  "received_at": "2026-06-11T10:00:01.000Z"
}
```

Result：

```json
{
  "type": "device_command_result",
  "command_id": "cmd_...",
  "request_id": "req_...",
  "result_id": "res_...",
  "status": "applied",
  "executed_at": "2026-06-11T10:00:02.000Z",
  "reason": "ok",
  "actions": [],
  "state_after": {}
}
```

服务端 WS ack：

- `device_command_receipt_received`
- `device_command_result_received`

HTTP ack：

- receipt 成功：`{ "received": true, "command_id": "...", "request_id": "..." }`
- result 成功：`{ "received": true, "command_id": "...", "request_id": "...", "result_id": "...", "duplicate": false }`

## 设备状态上报

HTTP `/api/report` 与 WS `device_status.payload` 共享上报主体核心字段：

```json
{
  "app_id": "com.example.app",
  "window_title": "Title",
  "timestamp": "2026-06-11T10:00:00.000Z",
  "extra": {
    "device": {
      "profile": "android_lsp",
      "capabilities": {
        "freeze": true,
        "unfreeze": true,
        "vibrate": true,
        "screen_off": false,
        "say": true,
        "risk_app_monitor": true,
        "app_time_limit": true
      },
      "frozen_packages": []
    },
    "foreground": {
      "package_name": "com.example.app",
      "app_name": "Example",
      "activity": "MainActivity",
      "title": "Title",
      "source": "lsposed",
      "confidence": 0.95
    }
  }
}
```

能力 profile：

- `android_lsp`：可上报冻结列表，可支持 `freeze`、`unfreeze`、`vibrate`、`say`、`risk_app_monitor`、`app_time_limit`；`screen_off` 当前固定为 `false`。
- `android_normal`：可 `vibrate`、`say`，不能冻结/解冻。
- `desktop_message`：只支持 `say`。
- `unsupported`：所有能力为 `false`。

WS `device_status` 可带 `status_id`。服务端成功处理后回：

```json
{
  "type": "ack",
  "status": "status_received",
  "status_id": "same-id"
}
```

## MCP 本地控制面

- 路径：`/api/mcp`。
- 只接受 loopback 来源；公网、Edge、CDN 不应代理或暴露该路径。
- 传输：无会话、JSON response 的 Streamable HTTP；只接受 `POST`。
- 可选 Header：`Authorization: Bearer <MCP_SERVER_TOKEN>`。未设置 token 时仅依赖 loopback。
- MCP 工具名固定：
  - `live_dashboard.list_devices`
  - `live_dashboard.get_all_device_timeline`
  - `live_dashboard.get_device_timeline`
  - `live_dashboard.get_device_frozen_list`
  - `live_dashboard.send_device_commands`
  - `live_dashboard.set_supervision_policy`
  - `live_dashboard.get_command_status`

## AI 结构化响应字段

监督决策 AI 输出当前使用中文结构化键：

```json
{
  "设备命令": [
    {
      "device_id": "android-phone",
      "是否偏离": true,
      "原因": "正在偏离目标",
      "冻结命令": ["com.example.video"],
      "解冻命令": [],
      "是否震动": true,
      "是否息屏": false,
      "要说的话": "回到今天目标"
    }
  ]
}
```

- `device_id` 必须来自设备能力上下文。
- `冻结命令` / `解冻命令` 会被转为 `freeze_commands` / `unfreeze_commands`。
- `解冻命令` 中的 `全部` 表示全量解冻。
- `是否震动` / `是否息屏` 必须是真布尔；服务端会按设备能力裁剪。

规则刷新 AI 输出：

```json
{
  "whitelist_app_regex": [],
  "blacklist_app_regex": [],
  "risk_app_regex": [],
  "target_app_regex": [],
  "reason": "..."
}
```

这些字段统一使用 snake_case，不能新增中文同义字段。
