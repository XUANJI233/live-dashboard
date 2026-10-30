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

- 路径：`/api/ws?role=device`、`/api/ws?role=integration` 或 `/api/ws?role=viewer`。
- 设备与 Android 集成 WS 必须带 `Authorization: Bearer <device_token>`；`integration` 只接受平台为 `android` 的设备 Token，并与 `device` 使用独立 socket 槽位，不能替换 LSPosed 主连接。
- 访客 WS 必须带 viewer token，可由 Edge 验证后签名回源，也可源站直接验证。
- 访客 `device_update` 与 `GET /api/current` 使用同一公开设备视图：不含 `window_title`、`extra.foreground.title` 和 `extra.device.installed_apps`，已安装应用只公开 `installed_apps_count`。
- 服务端连接 ack：
  - 设备：`{ "type": "ack", "status": "connected", "role": "device", "device_id": "..." }`
  - Android 集成：`{ "type": "ack", "status": "connected", "role": "integration", "device_id": "..." }`
  - 访客：`{ "type": "ack", "status": "connected", "role": "viewer", "viewer_id": "..." }`

### Android 集成 WS 帧

所有 `role=integration` 双向帧固定带 `v: 1`；缺失或其它版本必须拒绝，不能按当前版本猜测。服务端连接后发送 `{ "type":"integration_status_request", "v":1 }`，Android 回：

```json
{
  "type": "integration_status",
  "v": 1,
  "coyote": {
    "available": true,
    "connected": true,
    "device_name": "47L121...",
    "generation": "v3",
    "battery_percent": 80,
    "strength_a": 0,
    "strength_b": 0,
    "limit_a": 50,
    "limit_b": 50,
    "wave_active_a": false,
    "wave_active_b": false,
    "waveform_a": "",
    "waveform_b": "",
    "remote_control_enabled": false
  },
  "accounting": {
    "available": true,
    "last_sync_at": "2026-09-02T03:00:00.000Z",
    "last_error": ""
  }
}
```

郊狼命令：`{ "type":"coyote_command", "v":1, "request_id":"coyote_<uuid>", "command":{...} }`。`request_id` 由 MCP 调用方生成并在超时重试时原样复用；Android 持久保存该 ID 的命令指纹和结果，同 ID 同命令只重放结果，同 ID 不同命令返回 `coyote_request_id_conflict`。Android 只有在对应 GATT 写回调成功后才能返回 `status="applied"`：

```json
{
  "type": "coyote_command_result",
  "v": 1,
  "request_id": "coyote_00000000-0000-0000-0000-000000000000",
  "ok": true,
  "status": "applied",
  "reason": "applied",
  "coyote": {}
}
```

账单刷新：`{ "type":"accounting_sync_request", "v":1, "request_id":"accounting_<uuid>", "start":"<ISO>", "end":"<ISO>" }`；Android 完成源读取和全部上传后返回 `{ "type":"accounting_sync_result", "v":1, "request_id", "ok", "status", "accounting":{...} }`。服务端分别用 `coyote_command_result_received` / `accounting_sync_result_received`（均带 `v:1` 和原 `request_id`）确认结果。

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
- `controller_health`：GET/POST `/api/summary-settings` 与 MCP `get_service_settings` 都附带的只读状态，不写入设置、不发给 Hermes：`hermes_enabled`、`webhook_enabled`、`paused`、`last_ack_at`（最近一次收到匹配 ACK）、`last_failure_at` / `last_error`（最近一次投递失败）、`last_mcp_at`（最近一次带 token 的外部 MCP 调用）、`pending_count`、`oldest_pending_at`、`dead_last_24h`、`unreachable`。`unreachable=true` 表示 Live 在 10 分钟内仍在尝试投递、最近一次失败，且已有 30 分钟没有收到 ACK；此时若监督开启、未暂停，Live 每 6 小时最多向在线安卓手机发一次固定提示，不会自动切换控制器。
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
- `payload.kind` 只能是 `supervision`、`supervision_policy` 或 `screenshot`。
- `freeze_commands` / `unfreeze_commands` 是应用名或包名正则数组；客户端必须分别匹配包名、应用名和标题，不能只匹配三者拼接串，因此 `^com\\.example\\.app$` 必须能精确命中包名。
- `vibrate` / `screen_off` 必须是真布尔。
- `say` 是设备要展示/播报的话。
- `notes` 是服务端能力裁剪说明，例如 `freeze_not_supported`。

策略命令额外字段：

- `risk_app_regex`：由外部 AI 控制器编写的复核触发名单，匹配语义与冻结命令一致，分别作用于包名、应用名和标题；命中阈值只请求 AI 复核，不在端侧预先冻结。
- `risk_trigger_minutes`：风险名单中任一应用累计使用多少分钟触发 AI 监督。
- `review_interval_minutes`：外部控制器自动周期复核间隔（5–240 分钟），只保存在服务端，不下发到设备。
- `app_time_limits`：独立限时冻结策略，元素为 `{ "app_regex": "...", "limit_minutes": 10, "reason": "..." }`。
- `web_allowlist`：系统浏览器的严格网页白名单，`{ "allowed_domains": ["example.com"], "active_windows": [{ "days": [1,2,3,4,5], "start": "08:00", "end": "12:00" }] }`。
  - 域名同时放行其子域名，服务端统一为小写主机名（去掉协议、路径、端口和 `*.` 前缀），至少两段，最多 64 个；空列表表示关闭网页过滤。
  - `active_windows` 按手机本地时间判断，`days` 为 ISO 星期（1=周一，空表示每天），只支持同日内 `start < end`，跨夜写成两段，最多 14 段；空列表表示监督开启期间一直生效。
  - 生效期间 Android LSP 只放行系统浏览器（小米浏览器）：其它浏览器被单独挂起（不进 AI 冻结列表，不受“全部解冻”和每日重置影响），系统浏览器内非白名单的 http/https 导航在加载前被拦下。用户可在 App 内临时暂停，暂停有上限并会上报。
  - 监督关闭时有效策略中的 `web_allowlist` 为空；旧版 LSP 会忽略该字段，是否执行以设备能力 `web_allowlist` 为准。

截图命令使用 `payload.kind="screenshot"`，并带 `{ "screenshot_id", "max_width", "jpeg_quality" }`。Android LSP 截图后向 `POST /api/device-screenshots/{screenshot_id}` 上传受限 JPEG，Header 必须包含原 `X-Command-Id` 与实际宽高；服务端按设备身份、截图 ID 和命令 ID 三者绑定验收。

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

## AutoAccounting 完成账单同步

Android 只通过 AutoAccounting 现有本机接口 `http://127.0.0.1:52045/bill/range` 读取账单；不复制其 Hook、OCR、规则或数据库实现。上传端点为 `POST /api/accounting/bills`，必须使用平台为 `android` 的设备 Bearer token。

```json
{
  "source": "autoaccounting",
  "sync_id": "accounting_00000000-0000-0000-0000-000000000000",
  "range_start": "2026-09-01T00:00:00.000Z",
  "range_end": "2026-09-02T00:00:00.000Z",
  "batch_index": 0,
  "batch_count": 1,
  "bills": [
    {
      "source_bill_id": "123",
      "type": "Expend",
      "currency_code": "CNY",
      "money": 28.5,
      "fee": 0,
      "occurred_at": "2026-09-01T08:00:00.000Z",
      "shop_name": "示例商户",
      "shop_item": "示例商品",
      "category_name": "餐饮",
      "book_name": "默认账本",
      "account_name_from": "余额",
      "account_name_to": "",
      "app": "微信",
      "channel": "支付",
      "state": "Edited",
      "remark": "",
      "auto": true,
      "rule_name": "规则名",
      "tags": [],
      "flag": 0,
      "group_id": -1
    }
  ]
}
```

- 只接受 `state="Edited"` 或 `state="Synced"` 且 `group_id=-1` 的完成态主账单；`Wait2Edit` 与去重子账单必须跳过。
- 幂等键为 `device_id + source + source_bill_id`；同一来源账单再次上传会覆盖其已编辑字段，不产生重复记录。
- 一次范围快照的所有批次复用同一 `sync_id`，`batch_index` 从 0 开始；最后一批入库后，服务端删除该设备/来源/时间范围内未被本次快照标记的旧记录，因此已删除、退回 `Wait2Edit` 或变成子账单的数据不会继续被 MCP 返回。
- 单批最多 500 条。外部自由文本需在 Android 与服务端两次清洗并限制长度。
- MCP 查询可先通过 `integration` WS 事件式请求 Android 刷新指定时间范围；Android 不在线时返回服务端已有缓存与明确的 `refresh.status="offline"`，不得伪装成实时结果。

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
- `android_lsp` 只有显式上报 `web_allowlist:true` 才表示执行网页白名单，并在 `extra.device.web_allowlist` 上报执行状态：`active`、`paused_until`、`browser_package`、`allowed_domain_count`、`paused_browsers`、`last_blocked_host`、`last_blocked_at`。该状态只在设备上下文中给控制器读取，不进入 `/api/current` 和访客 `device_update`。
- `android_lsp` 只有显式上报 `screenshot:true` 才能接收截图命令。截图由 LSP 调用系统截图能力、缩放并压成受限 JPEG，经设备鉴权上传；MCP 图片读取一次后删除，过期记录自动清理。
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
  - `live_dashboard.get_accounting_bills`
  - `live_dashboard.get_coyote_status`
  - `live_dashboard.coyote_start`
  - `live_dashboard.coyote_adjust`
  - `live_dashboard.coyote_change_wave`
  - `live_dashboard.coyote_stop`
  - `live_dashboard.coyote_emergency_stop`
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
  - `live_dashboard.get_rest_state`
  - `live_dashboard.record_commitment`
  - `live_dashboard.end_commitment`
  - `live_dashboard.list_commitments`
  - `live_dashboard.request_exception_unfreeze`
- `live_dashboard.get_rest_state` 是给 Hermes 门控脚本的轻量读取，只返回 `{ rest_state, generated_at }`（`asleep` / `screen_off` / `active` / `unknown`），不带时间线或消息；门控脚本经本机 MCP listener 带 token 调用，不再读公开的 `/api/current`。
- Live 与 Hermes 两侧的事件校验共用 `deploy/hermes/tests/fixtures/controller_events.json` 契约样例：时间戳必须带时区、日期必须是真实日历日、`ai_request` 只允许 `request_id`/`kind`/`payload` 三个键、`settings_updated_at` 最长 80 字符。CI 同时运行两侧测试。
- `live_dashboard.send_device_commands` 只用于一次性设备动作：提醒文本、震动、息屏、即时冻结/解冻；服务端会按设备显式上报能力裁剪。
  - 用户的监督开关在服务端对所有控制器强制生效：监督总开关关闭时冻结、震动、息屏都会被去掉（备注 `supervision_disabled`）；“LSP 短时冻结”关闭时去掉冻结（`freeze_disabled_by_user`）；“偏离时震动”关闭时去掉震动（`vibrate_disabled_by_user`）。解冻、说话和截图不受开关限制。只剩被用户开关去掉的动作时，命令结果为 `ignored`，原因即上述备注。
  - 调用会等待约 3 秒设备结果再返回（只等已送达的命令）；`results_pending: true` 表示还有命令没出结果（含手机离线、命令排队），之后再用 `get_command_status` 查。
  - 解冻模式只要可能命中当前生效承诺里的应用（手机会拿它去匹配包名、应用名和冻结原因；`全部`/`全量`/`所有`/`all`/`*`/`.*` 是全匹配；Java 正则专有写法按可能命中处理），就会被换成它能命中的已知冻结应用的精确包名、去掉承诺内的包，备注 `commitment_locked`；换完一个不剩时结果为 `ignored`，换出超过 12 个时多出的截掉并备注 `unfreeze_targets_truncated`。承诺内应用只能走 `request_exception_unfreeze`。
  - 传入 `request_id` 即为幂等：同一 `request_id` 带相同命令重试时直接返回已记录的命令状态并带 `duplicate: true`，不会再次下发；同一 `request_id` 换了命令内容则返回 `request_id_conflict`。
- 承诺（`controller_commitments`）是用户在冷静时亲口定下的规则：`record_commitment` 记录原话、`kind`（`block` 封禁 / `task` 只记录）、`block` 的 Android LSP 设备（`device_not_found` / `device_cannot_freeze`）、精确包名（不接受正则，最多 20 个；手机暂未安装的返回在 `not_installed` 里，装上后自动冻结）、可选每日时段 `window_start`/`window_end`（本地 `HH:MM`，可跨午夜，省略为全天）、可选 `ends_at`（必须带 `Z` 或 `+08:00` 这类时区）、每日例外次数（默认 2，0–5）和单次例外上限分钟（默认 30，5–60）。只有用户明确取消或替换时才用 `end_commitment` 结束；`ends_at` 到期自动结束。`get_controller_context` 各模式都带 `commitments`（上下文超预算时只裁剪、不丢弃），含今天已用和剩余例外、未到期例外。
  - 服务端每分钟按包同步 `block` 承诺，不依赖控制器唤醒：每个包一条锚定的精确命令（`^com\.taobao\.taobao$`），只有该命令的结果改变包状态。冻结生效后记下手机给的 `until`（本地次日 03:00），过期即补冻；手机上报里列出的冻结应用最多 8 个、解冻时只扫 16 条记录，所以不靠上报判断。时段结束、承诺结束或例外开启时解冻该包，未确认就每 2 分钟重试，最多 4 次；仍被其它生效承诺占用的包不动。手机说没装的包 1 小时后再试，其它失败 10 分钟后再试。执行走用户监督开关：关闭 LSP 冻结后不再冻结。控制器暂停不影响承诺执行。
  - `request_exception_unfreeze` 字段：`device_id`、`package_name`、`purpose`（至少 2 字）、`minutes`。一次例外对所有在时段内持有该包的承诺同时生效：每条承诺都要有剩余额度并各扣一次，分钟数不超过其中最严的上限。例外期间再要同一个包返回已开的那次（`reused: true`），不再扣额度。服务端精确解冻并返回 `relock_at`、`exceptions_left_today`，到点后自动补冻。错误码：`not_committed`（不在生效承诺里，用普通解冻）、`commitment_exception_denied`（某条承诺今天额度已用完）、`exception_minutes_out_of_range`、`exception_purpose_required`、`device_offline` 与 `exception_not_delivered`（都不扣额度）。
- `live_dashboard.capture_device_screenshot` 用于按需抓取 Android LSP 当前画面；默认事件式等待上传，超时返回 `screenshot_id`。`live_dashboard.get_device_screenshot` 用该 ID 取回一次图片。
- `live_dashboard.get_accounting_bills` 只查询 AutoAccounting 已处理完成并同步到服务端的原始主账单字段；默认先通过 Android `integration` WS 请求指定时间范围的事件式刷新，不重新解释账务汇总语义。最多返回 200 条；`truncated=true` 时必须把 `next_cursor` 原样传入下一次调用，直到 `next_cursor=null`。
- 郊狼工具只作用于 Android 集成当前已连接的 Coyote V2/V3：`coyote_start` 冷启动强度上限 10，`coyote_adjust` 单步上限 ±10，且 Android 会再次按用户 A/B 通道上限裁剪；`coyote_change_wave` 不改变强度。上述三项需要 Android 本地显式开启远程控制；`coyote_stop` 与 `coyote_emergency_stop` 不受启动授权限制，紧急停止会立即归零并清空波形。
- `live_dashboard.set_supervision_policy` 是外部 AI 控制器编写持久监督策略的唯一接口：AI 根据当前目标和证据主动创建、修改或清空复核触发规则、触发分钟数和明确的离线应用限时；不要让部署者预填固定名单，也不要用于一次性提醒、一次性冻结/解冻或普通聊天消息。
  - 输入必须是完整快照：`policy_owner`、`strategy_reason`、`review_interval_minutes`、`risk_app_regex`、`risk_trigger_minutes`、`app_time_limits` 缺一不可；`web_allowlist` 可省略，省略等同于空白名单（关闭网页过滤），不会保留旧值。
  - 分类规则也由控制器维护并属于快照：`whitelist_app_regex`（服务目标的应用，会屏蔽黑名单与风险命中）、`blacklist_app_regex`（明确偏离目标的应用）、`target_app_regex`（当前目标需要的应用），各最多 12 条、每条最多 120 字符；省略即清空。它们驱动服务端的规则命中复核、目标不足判断和 `usage_digest` 分类。
  - 所有正则（含应用限时的 `app_regex`）都按服务端编译规则校验；服务端会丢弃的危险或无效正则（如 `.*`、`(a+)+`）直接返回 `unsafe_policy_regex`，整次写入不生效，避免设备执行一条服务端自己忽略的规则。
  - 可选 `expected_policy_updated_at`：填上次读到的 `policy_updated_at`，若期间已有其它写入则返回 `policy_conflict` 且不改动，控制器应重读后再写。
  - 策略写入只更新 `supervision_policy_updated_at` / `supervision_rules_updated_at`，不改用户设置的 `updated_at`，因此不会让手机随后的设置保存被判为 `ignored_stale`。
  - `policy_owner` 必须与已启用的控制器 persona 一致（`openclaw` / `hermes` / `custom`）；Live 冷备 AI 接管时服务端内部记录为 `live_ai`，不冒充外部控制器。
  - 交回 Live AI 后，Live AI 的规则刷新只改写分类规则；之前由外部控制器写入的复核间隔、风险触发、风险正则、应用限时和网页白名单保持生效且 owner 不变，直到某个控制器整体替换策略或用户关闭监督。只有当前 owner 已是 `live_ai`（或从未写过策略）时，刷新才会重置为 Live AI 默认值。刷新以模型返回后的最新设置为基础保存，期间用户的设置修改不会被覆盖。
  - 服务端整体替换旧策略，不接受依赖旧字段的部分更新。执行设备只接收三项执行字段，作者、理由与更新时间留在服务端设置中用于审计。
- `live_dashboard.update_service_settings` 只接受 snake_case 字段和真布尔，不接受手机端同义 camelCase。`live_dashboard.set_summary_mode` 是服务端控制语气的唯一远程工具；如果 `AI_SUMMARY_MODE` 环境变量存在，则环境变量优先。
- `live_dashboard.update_controller_persona` 用于同步 OpenClaw/Hermes 人设或附属关系。字段全部为 snake_case：`enabled`、`controller`（`openclaw` / `hermes` / `custom`）、`controller_name`、`persona`、`relationship`、`style_notes`。同步内容会加入日/周总结和监督 system prompt，使服务口吻保持控制器一致；它不能覆盖安全、隐私、JSON schema、输出格式或设备能力约束。
  - 暂停：已保存过的人设被设为 `enabled=false` 即为用户暂停。暂停期间 Live 不再因定时复核、规则命中、设备显式请求或设备离线唤醒控制器，结果分别为 `controller_paused` 或不入队；用户主动发起的 AI 工作（日/周总结、设置保存后的规则刷新）照常委托。已下发到手机的硬限制（应用限时、网页白名单）继续生效，暂停期间控制器也不能改写策略。从未保存过人设不算暂停。
- `live_dashboard.get_controller_memory_feed` 用于把公开/私聊消息、设备回复、服务端下发的提醒/控制命令以及已保存的日/周总结回流给 OpenClaw/Hermes。字段：`since`、`cursor`、`limit`、`include_messages`、`include_public_messages`、`include_summaries`、`include_device_commands`，布尔必须是真布尔。`get_controller_context` 在 `supervision` 和 `policy` 模式下不带匿名公开留言及公开回复（`include_public_messages=false`），避免访客文本进入会冻结或改配置设备的回合。分页应优先传回上次响应的 `next_cursor`；只用 `next_since` 可能重复同一时间戳事件，不能保证无重复。
- 推荐由 OpenClaw/Hermes 读取 memory feed 后自行整理长期记忆和总结，再调用 `live_dashboard.save_controller_summary` 写回服务端。`save_controller_summary` 字段：`kind`（`daily_summary` / `weekly_summary`）、`date`、`week_start`、`summary`、`mode`、`target`；服务端仍会清洗 HTML、链接、脚本、命令和控制字符。
- `HERMES_CONTROLLER_ENABLED=false` 时，`live_dashboard.start_ai_job` 可启动日总结、周总结、监督规则刷新或监督复核；`live_dashboard.get_ai_job` 按 `request_id` 查询状态；`live_dashboard.run_supervision_check` 会排队一个 `supervision_check` job 并立即返回。
- `HERMES_CONTROLLER_ENABLED=true` 时，所有客户端 Live AI job 都写入同一 AI job 幂等账本，但 runner 只生成 `ai.work_requested` 控制器事件，不调用 Live 模型。Webhook 接收后 job 状态为 `delegated`，不是提前伪报 `succeeded`；Hermes 原子认领后，完成、跳过或失败时必须用认领返回的 `request_id` 和 `claim_token` 调用 `complete_controller_ai_request` 结算状态。`ai_config_test` 直接返回 `managed_by="hermes"`，不会用冷备用 Key 发模型请求。Hermes 应使用 `get_controller_context` 一次取得有界上下文，再用 `save_controller_summary`、`set_supervision_policy`、`send_device_commands` 等明确工具完成工作。
  - 委托 job 不会无限挂起：2 小时内未被认领的 `delegated` job 转为 `failed`（`AI_JOB_DELEGATION_TIMEOUT`）；以 `HERMES_CONTROLLER_ENABLED=false` 重启时，遗留的 `delegated` / `processing` job 转为 `failed`（`AI_JOB_CONTROLLER_INACTIVE`）。两者都可重试：客户端用同一 kind/key 重新提交会重启该 job。Live AI 模式下重新提交仍处于 `delegated` 的 job 也会由 Live 重启。Hermes 模式关闭时 `claim_controller_ai_requests` / `complete_controller_ai_request` 返回 `hermes_controller_inactive`。
- MCP 工具失败时结果带 `isError: true`，`structuredContent` 为 `{ "ok": false, "error": "<code>" }`；带类型的错误（如 AI job 的 `AI_JOB_NOT_FOUND`）以小写保留为 `ai_job_not_found`，不再一律变成 `internal_error`。文本视图是与 `structuredContent` 等价的紧凑 JSON。

## Hermes 控制模式

- 只有环境变量严格等于字符串 `true` 时才启用；`false`、未设置、`1` 或其它值都维持原 Live AI 行为。
- 启用时 Live 继续采集、存储、计算确定性候选、提供 MCP 和执行已授权命令，但不运行内部 AI 总结、规则生成或监督复核。
- Live AI endpoint、模型和 Key 保留为冷备用；切换回 `false` 后原路径恢复。该模式只允许显式人工切换，不做自动健康检查故障转移，避免 Live 与 Hermes 双主。
- `get_service_settings` 返回 `controller_mode.hermes_enabled`、`internal_ai_enabled` 和 `webhook_enabled`，供控制器确认当前所有权。

## 控制器出站 Webhook

Hermes 模式下，Live 可把高价值的确定性监督候选作为最小事件发送给同机 Hermes。该出口默认关闭；只有 `HERMES_CONTROLLER_ENABLED=true`、`CONTROLLER_WEBHOOK_ENABLED=true` 且同时配置 URL 与独立 secret 时才发送。Webhook secret 不能复用 `HASH_SECRET`、设备 token 或 MCP token。

同一出口也承载 `ai.work_requested`：日／周总结、策略刷新和显式监督请求只携带白名单化日期、时区、请求 ID 与布尔参数，不能携带 API Key、自由 prompt 或未清洗正文。Live 按 job key 合并相同请求；所有按需请求路由到同一个 Hermes 控制器 job。该专用消费者用 `claim_controller_ai_requests` 原子取得 30 分钟租约和逐项随机 `claim_token`，保存真实结果后凭相同令牌结算；其它 companion/memory/daily job 和过期认领者无法完成同一请求，因此 webhook note 覆盖和并发 cron 都不会造成丢失或重复模型调用。

当前事件 schema：

```json
{
  "schema": "live_dashboard.controller_event.v1",
  "v": 1,
  "event_id": "supervision:494677:0123456789abcdefabcd",
  "event_type": "supervision.review_requested",
  "occurred_at": "2026-06-11T10:00:00.000Z",
  "source": "scheduled",
  "device_ids": ["android-phone"],
  "reason_codes": ["scheduled_check", "blacklist_threshold"]
}
```

- 事件只表示“请 Hermes 复核”，不是 Live 已确认偏离。显式设备请求可直接成为候选，不受报告共享的 60 秒节流限制，也不要求报告带前台应用；普通报告仍经过白名单/黑名单/风险规则；定时检查只在到达 AI 保存的复核间隔时唤醒 Hermes 做一次周期复核，规则未覆盖的应用也由这次复核判断，未到间隔的轮次在模型前结束。到点的周期复核会先与上次已投递的周期复核比较时长摘要的实质内容（每台设备占用至少 5 分钟的应用及其规则类别）：没有变化就不唤醒 Hermes，结果为 `usage_unchanged_since_review`；最多连续跳过 2 轮，且距上次已投递的复核满 4 小时必定复核。规则命中和设备显式请求不受此限制。
- `v` 当前固定为 `1`；`event_id`、`device_ids` 和 `reason_codes` 只允许协议规定的 ASCII 安全集合。
- `event_id` 由通知冷却时间桶和已验证设备集合稳定派生；同一时间桶内的重试必须复用同一 ID。
- 普通上报的规则命中按设备使用 10 分钟冷却桶：应用持续打开时每次上报都会命中，同一窗口内只产生一次复核事件，与 LSP 同一应用的请求冷却一致。设备显式请求（`device_requested`）仍用 1 分钟桶，由设备端节流。
- Payload 只携带稳定元数据，不携带原始窗口标题、时间线、AI 自由文本、token 或密钥；Hermes 收到后必须通过 MCP 读取必要的最小时间窗并自行复核。
- `live_dashboard.get_controller_context` 是 Hermes 每轮唯一的聚合读取：一次返回设置、人设、设备/睡眠状态、`usage_digest`、有界时间线和近期事件。`content` 是不缩进的完整 JSON，且与 `structuredContent` 语义完全相同，以兼容只识别任一视图的 MCP 客户端；两者各自的 UTF-8 上限为 24 KB。Hermes 适配器在进入模型上下文前对等价视图去重，所以模型侧结果保持在 50K spillover 阈值以内。`bounds.truncated=true` 只代表省略较旧或低优先级信息；当 `decision_complete=true` 且 `followup_required=false` 时不得据此重复读取。只有选定动作确实缺少一个具体事实时，才允许调用对应的单项工具。
- `usage_digest`（schema `live_dashboard.usage_digest.v1`）由 Live 用代码计算，不调用模型，覆盖整个上下文窗口。每台设备（最多 6 台，按活跃时长排序，请求的 `device_id` 排第一）给出 `active_minutes`、`current`（当前应用、类别、开始时间与连续分钟）、`class_minutes`、前 6 个应用的分钟与类别，以及 `app_count` 和 `switches`。类别按已保存的监督规则判定，每段只计入第一个命中的 `blacklist`、`risk`、`target`、`whitelist`，都不命中为 `unclassified`。摘要只含应用名和包名，不含窗口标题；行数超限时保留最新部分并标记 `truncated=true`。
- `supervision`、`companion`、`followup` 模式的 `timeline` 只保留最近 8 段并带 `recent_only=true`，这本身不算截断，不进入 `bounds.truncated_sections`。摘要留下与决策相关的疑问时，Hermes 对一台设备、一个时间窗调用一次 `live_dashboard.get_device_timeline` 查看细节。其它模式的时间线上限不变。
- 事件使用上述 V2 HMAC headers；Hermes 应把 `X-Request-ID` 作为幂等键。
- `device.offline` 只在意外断线时发送：设备下线前已在睡眠、熄屏或空闲（`sleeping`、空应用、`idle`/`sleeping`），或可信手表显示用户正在睡觉时，设备仍会标记离线，但不唤醒控制器。
- 投递与重试：Live 先把事件写入持久 outbox 再投递。每次投递最多尝试 2 次、每次等待 10 秒（长于 Hermes 触发脚本等待网关回执的 6 秒），只有带匹配 `event_id` 的 ACK 才算送达。失败后按 1、2、4、8、16 分钟、此后每 30 分钟退避重试；连续 3 次网络级失败会让本轮投递提前结束，避免控制器挂掉时逐条超时。到期未送达的事件不会阻塞更新的事件。
- 死信与过期：4xx（408/429 除外）、`secret_reused`、损坏的 outbox 行或累计 8 次失败的事件转入死信，不再重试。事件有有效期：复核请求 30 分钟，设备离线 2 小时，AI 工作请求 24 小时；过期事件不会在恢复后补发，引入有效期之前写入的旧行超过 24 小时即视为过期。死信与过期行保留 14 天后清理。
- 复核合并：新复核事件入队时，同设备集合内尚未送达的旧复核事件被标记为 `superseded`，其 `reason_codes` 并入新事件（例如 `device_requested` 不会丢失），Hermes 只需处理携带最新状态的一次复核。已经在投递中的旧事件仍会送达。
- 候选节流不复用设备命令的 `supervision_last_alert_at`，避免检测与执行相互抑制。
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
