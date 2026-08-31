# API Protocol Contracts

更新时间：2026-06-13

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
| `X-Webhook-Timestamp` | Live -> Hermes | Unix 秒时间戳；与原始 JSON body 一起参与控制器 Webhook V2 HMAC。 |
| `X-Webhook-Signature-V2` | Live -> Hermes | `HMAC-SHA256(secret,"<timestamp>.<raw_body>")` 十六进制签名，防止伪造和重放。 |
| `X-Request-ID` | Live -> Hermes | 稳定控制器事件 ID；Hermes 用于 Webhook 幂等去重。 |

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

## AI 设置和 Prompt

`GET /api/summary-settings` 和 `POST /api/summary-settings` 使用设备 Bearer token。JSON 字段保持 `snake_case`，布尔必须是真布尔。

App 保存设置时应发送：

- `target`：默认目标/背景，最多 1000 字符，允许换行。
- `weekly_plan[].target`：单日目标，最多 1000 字符，允许换行。
- `timezone_offset_minutes`：客户端本地时区偏移，语义同 JavaScript `Date.getTimezoneOffset()`，例如 UTC+8 为 `-480`。
- `ai_deep_thinking`：统一 AI 深度思考开关，不带 provider 名称；服务端只在当前供应商支持时映射到 provider options。
- `supervision_include_installed_apps`：监督规则/复核是否把设备上报的非系统应用快照作为 AI 上下文，默认 `true`。
- `supervision_heuristic_triggers`：是否允许服务端在硬阈值前按黑名单/风险占比启发式提前复核。默认 `false`，开启后可能增加 AI 请求和 token 用量。
- `supervision_blacklist_minutes` / `supervision_risk_trigger_minutes` / `supervision_target_min_minutes`：监督硬触发阈值。启发式开关开启时，服务端可在硬阈值前按黑名单/风险占比提前复核，但仍必须由 AI 做最终判断。
- `mode`：服务端会忽略 App 提交的该字段；总结/监督语气只能由服务端环境变量 `AI_SUMMARY_MODE` 或 MCP 工具 `live_dashboard.set_summary_mode` 控制，防止手机端切换绕过监管。
- 服务端发给 AI 的当前时间以用户本地时间优先展示，同时附带 UTC ISO 和 `timezone_offset_minutes`，避免模型误用部署机时区。
- 监督 AI 的定时复核与条件触发并行：定时复核按 `supervision_check_interval_minutes` 运行；LSP 风险/黑名单/目标不足触发可以在定时复核之间额外发起复核。`supervision_check_mode` 仅保留兼容旧客户端语义，不应被理解为二选一调度开关。

服务端保存后可能返回：

- `mode_locked`：固定为 `true`，表示 App 不能修改总结/监督语气。
- `sync_status`：`applied` 或 `ignored_stale`。
- `rules_refresh_job`：监督规则异步刷新 job；`status` 为 `queued` / `running` 时客户端应显示“规则正在生成”，不要把旧 `supervision_rules_updated_at` 当作本次完成时间。

服务端 prompt 覆盖文件：

- 默认路径：`AI_PROMPTS_FILE`；未设置时在 `DB_PATH` 同目录自动生成 `ai-prompts.json`。
- 固定键：`daily_summary_system`、`weekly_summary_system`、`supervision_rules_system`、`supervision_verify_system`。
- 字段缺失或空字符串表示使用内置默认提示词。
- 覆盖范围只限 system prompt；时间线 JSON、设备能力/冻结列表、当前本地时间、最终任务指令和结构化 JSON schema 仍由服务端生成。

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

- `android_lsp`：可上报冻结列表，可支持 `freeze`、`unfreeze`、`vibrate`、`say`、`screen_off`、`risk_app_monitor`、`app_time_limit`；其中 `screen_off` 必须由新端侧显式上报为 `true` 才会下发。
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

## MCP 控制面

- 路径：`/api/mcp`。
- 主服务 `/api/mcp` 默认关闭远程访问；公网、Edge、CDN 不应在未设置 `MCP_REMOTE_ENABLED=true` 和 token 时代理或暴露该路径。
- 本机控制器可连接独立 listener `http://127.0.0.1:${MCP_PORT || 3031}/api/mcp`，推荐携带 `Authorization: Bearer <MCP_SERVER_TOKEN>`。
- 未配置 token 的 loopback 独立 listener 只在 `MCP_LOOPBACK_TOKENLESS_ENABLED=true` 时放行；该开关仅用于可信单用户本地开发。
- Docker 宿主机本地控制器访问独立 MCP listener 时，应设置 `MCP_HOST=0.0.0.0`、`MCP_LOCAL_NETWORK_ENABLED=true`、`MCP_SERVER_TOKEN=<强随机值>`，并只把 `${MCP_PORT}` 映射到宿主机 `127.0.0.1`。
- 远程 OpenClaw/Hermes 连接需显式设置 `MCP_REMOTE_ENABLED=true`，且必须设置 `MCP_SERVER_TOKEN` 或 `MCP_ADMIN_TOKEN`。远程客户端使用主服务 `https://<host>/api/mcp` 和 `Authorization: Bearer <token>`。
- 传输：无会话、JSON response 的 Streamable HTTP；只接受 `POST`。
- Header：`Authorization: Bearer <MCP_SERVER_TOKEN>`。仅显式开启 `MCP_LOOPBACK_TOKENLESS_ENABLED=true` 的本机开发环境可省略。
- MCP 工具名固定：
  - `live_dashboard.list_devices`
  - `live_dashboard.get_all_device_timeline`
  - `live_dashboard.get_device_timeline`
  - `live_dashboard.get_device_frozen_list`
  - `live_dashboard.get_device_installed_apps`
  - `live_dashboard.send_device_commands`
  - `live_dashboard.set_supervision_policy`
  - `live_dashboard.get_command_status`
  - `live_dashboard.get_service_settings`
  - `live_dashboard.update_service_settings`
  - `live_dashboard.set_summary_mode`
  - `live_dashboard.get_controller_persona`
  - `live_dashboard.update_controller_persona`
  - `live_dashboard.get_controller_memory_feed`
  - `live_dashboard.save_controller_summary`
  - `live_dashboard.start_ai_job`
  - `live_dashboard.get_ai_job`
  - `live_dashboard.run_supervision_check`
- `live_dashboard.send_device_commands` 只用于一次性设备动作：提醒文本、震动、息屏、即时冻结/解冻；服务端会按设备显式上报能力裁剪。
- `live_dashboard.set_supervision_policy` 只用于持久监督策略：风险应用 AI 触发规则、触发分钟数和应用限时；不要用于一次性提醒、一次性冻结/解冻或普通聊天消息。
- `live_dashboard.update_service_settings` 只接受 snake_case 字段和真布尔，不接受手机端同义 camelCase。`live_dashboard.set_summary_mode` 是服务端控制语气的唯一远程工具；如果 `AI_SUMMARY_MODE` 环境变量存在，则环境变量优先。
- `live_dashboard.update_controller_persona` 用于同步 OpenClaw/Hermes 人设或附属关系。字段全部为 snake_case：`enabled`、`controller`（`openclaw` / `hermes` / `custom`）、`controller_name`、`persona`、`relationship`、`style_notes`。同步内容会加入日/周总结和监督 system prompt，使服务口吻保持控制器一致；它不能覆盖安全、隐私、JSON schema、输出格式或设备能力约束。
- `live_dashboard.get_controller_memory_feed` 用于把公开/私聊消息、设备回复、服务端下发的提醒/控制命令以及已保存的日/周总结回流给 OpenClaw/Hermes。字段：`since`、`cursor`、`limit`、`include_messages`、`include_summaries`、`include_device_commands`，布尔必须是真布尔。分页应优先传回上次响应的 `next_cursor`；只用 `next_since` 可能重复同一时间戳事件，不能保证无重复。
- 推荐由 OpenClaw/Hermes 读取 memory feed 后自行整理长期记忆和总结，再调用 `live_dashboard.save_controller_summary` 写回服务端。`save_controller_summary` 字段：`kind`（`daily_summary` / `weekly_summary`）、`date`、`week_start`、`summary`、`mode`、`target`；服务端仍会清洗 HTML、链接、脚本、命令和控制字符。
- `live_dashboard.start_ai_job` 用于启动日总结、周总结、监督规则刷新或监督复核；`live_dashboard.get_ai_job` 按 `request_id` 查询状态；`live_dashboard.run_supervision_check` 会排队一个 `supervision_check` job 并立即返回，不同步等待 AI，默认按 `source="report"` 运行以避免推进定时监督节流。

## 控制器出站 Webhook

Live 可把已经确认的高价值监督异常作为最小事件发送给同机 Hermes。该出口默认关闭；只有 `CONTROLLER_WEBHOOK_ENABLED=true` 且同时配置 URL 与独立 secret 时才联网。Webhook secret 不能复用 `HASH_SECRET`、设备 token 或 MCP token。

当前事件 schema：

```json
{
  "schema": "live_dashboard.controller_event.v1",
  "event_id": "supervision:2026-06-11T10:00:00.000Z",
  "event_type": "supervision.deviation_detected",
  "occurred_at": "2026-06-11T10:00:00.000Z",
  "source": "scheduled",
  "device_ids": ["android-phone"],
  "reason_codes": ["deviation_confirmed"]
}
```

- 正常、已恢复、无时间线、未达触发条件或 AI 判定失败都不发送该事件。
- Payload 只携带稳定元数据，不携带原始窗口标题、时间线、AI 自由文本、token 或密钥；Hermes 收到后必须通过 MCP 读取必要的最小时间窗并自行复核。
- 事件使用上述 V2 HMAC headers；Hermes 应把 `X-Request-ID` 作为幂等键。
- 同一监督异常遵循独立控制器通知冷却，不复用设备命令的 `supervision_last_alert_at`，避免两条节流链互相抑制。
- Docker 内的 Live 访问宿主 Hermes 时使用仅宿主/容器可达地址；不要把 Hermes Webhook 端口代理到公网。

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
