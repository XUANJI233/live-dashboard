# Live Dashboard Android App — 代码指南

> 更新：2026-03-22

## 构建与部署

- **最低 SDK**：见 `app/build.gradle.kts` → `minSdk` (26)
- **构建普通版**：`./gradlew assembleNormalDebug`（在 `agents/android-app/` 下执行）
- **构建 Root/LSPosed 版**：`./gradlew assemblePrivilegedDebug`
- **APK 输出**：`app/build/outputs/apk/normal/debug/app-normal-debug.apk`、`app/build/outputs/apk/privileged/debug/app-privileged-debug.apk`
- **安装普通版**：`adb install -r app/build/outputs/apk/normal/debug/app-normal-debug.apk`
- **安装 Root/LSPosed 版**：`adb install -r app/build/outputs/apk/privileged/debug/app-privileged-debug.apk`

## 设计决策

- **普通 APK 不做前台应用检测**：Android 非 root 下无法可靠获取前台应用。普通版只上报在线、电量和健康数据，也不包含 LSPosed 模块元数据。
- **Root / LSPosed APK 单独打包**：Root 版使用 `com.monika.dashboard.privileged` 包名；root 模式低频读取系统 dumpsys；LSPosed 模式固定 system scope，优先使用系统服务事件，避免 hook 全部应用。
- **不读取后台通知正文**：只上报与当前状态有关的信息。媒体状态只上传播放中元数据；输入状态只上传布尔值，不上传文本、剪贴板或候选词。
- **位置 / VPN / 输入状态均为可选**：位置只读取最近已知位置，不主动高频定位；VPN 只上传连接状态；输入状态只上传布尔值。
- **仅 WorkManager**：HeartbeatWorker 使用自调度 OneTimeWorkRequest 绕过 15 分钟最小周期。底层 AlarmManager 即使被冻结也能唤醒。
- **心跳默认关闭**：不是所有用户都需要显示手机在线，作为可选功能。

## 关键流程

### 心跳流程（可选）
1. 用户在 SetupScreen 点击「开始监听」→ `HeartbeatWorker.schedule(context, interval)`
2. HeartbeatWorker 延迟触发 → 读取电量信息
3. `ReportClient.reportApp()` POST 到 `/api/report`，包含当前能力模式、电量、网络状态；root/LSPosed 模式下可包含前台应用、输入布尔值和媒体状态，空闲态会显式上报为 `idle`
4. Worker 自调度下一个 OneTimeWorkRequest
5. 通过 AlarmManager 存活于小米进程冻结

### 实时消息连接流程
1. `MainActivity` 启动时调用 `MessageSocketManager.ensureStarted(applicationContext)`
2. `MessageSocketManager` 使用 `GET /api/ws?role=device` 的 WebSocket 通道接收私聊和公开留言变更
3. 连接断开时消息页面会通过 HTTP 历史记录补齐，不再使用全局 TopAppBar 显示连接状态，避免顶部信息重复和误导

### AI 总结流程
1. 概览页通过 `GET /api/daily-summary` 或 `GET /api/weekly-summary` 读取服务端缓存总结
2. 用户点击刷新时，App 使用设备 Bearer token 调用 `POST /api/daily-summary` 或 `POST /api/weekly-summary` 让服务端重新生成
3. 设置页“总结”分段通过 `GET/POST /api/summary-settings` 读取和保存总结模式（温和/一般/锐评）与近期目标
4. 设置页“AI 连接”通过 `GET /api/ai-config` 获取服务端 X25519 公钥；保存 AI 端点/Key/模型时使用临时 X25519 密钥协商、HKDF-SHA256、AES-256-GCM 加密，并用设备 token 做 HMAC-SHA256 签名
5. 如果服务器已有 `AI_API_URL` / `AI_API_KEY` 环境变量，`POST /api/ai-config` 会返回锁定错误，App 弹窗提示且不覆盖服务器配置
6. 模式和目标只存在服务器；公开读取总结时不会返回目标文本

### 健康数据同步流程
1. 用户在 HealthScreen 授权 Health Connect 权限
2. 若设备开放 `FEATURE_READ_HEALTH_DATA_IN_BACKGROUND`（以设备与 Health Connect 的 feature 检测结果为准），再额外授权后台读取权限
3. 选择数据类型 + 同步间隔
4. `HealthSyncWorker` 通过 WorkManager 定时运行
5. 从 Health Connect 读取 → POST 到 `/api/health-data`

> 若设备不支持后台读取，APP 仍会在打开时自动执行前台同步；不会伪装成“后台已开启”。

## 常见问题

| 症状 | 原因 | 解决 |
|------|------|------|
| 「未连接」但服务器正常 | URL 缺少 `https://` 或 Token 为空 | 检查 SetupScreen 配置，确认已保存 |
| `TLSV1_ALERT_UNRECOGNIZED_NAME` | 服务端 TLS/SNI 主机名不匹配，或 9443 等端口没有真正提供 HTTPS/WSS | `https://example.com:9443` 可以使用，但证书必须覆盖 `example.com`，反向代理要有对应 `server_name` 并转发 WebSocket Upgrade |
| 健康同步不工作 | Health Connect 未安装、读取权限未授权、或设备未开放后台读取特性 | 安装 Health Connect，在 HealthScreen 先授权读取；若要后台同步，再确认设备支持并授权“后台同步” |
| 耗电快 | 心跳间隔过低（如 10s） | 将间隔调整到 20-50s |
| Token 保存失败 | EncryptedSharedPreferences 不可用（旧设备） | SetupScreen 会显示警告，无解决方案 |
| 后台被杀 | OEM 电池优化 | StatusScreen → 忽略电池优化 + 厂商特殊设置 |

## API 接口

| 方法 | 路径 | 用途 | 调用者 |
|------|------|------|--------|
| POST | `/api/report` | 心跳上报（电量 + 在线状态） | HeartbeatWorker |
| POST | `/api/health-data` | 上传健康数据记录 | HealthSyncWorker |
| GET | `/api/messages` | 拉取离线排队的游客消息 | HeartbeatWorker |
| POST | `/api/messages/reply` | 回复游客消息 | HeartbeatWorker |
| WS | `/api/ws?role=device` | 实时双向消息 | MessageSocketManager |
| GET | `/api/daily-summary` | 读取日总结 | OverviewScreen |
| POST | `/api/daily-summary` | 管理员刷新日总结 | OverviewScreen |
| GET | `/api/weekly-summary` | 读取周总结 | OverviewScreen |
| POST | `/api/weekly-summary` | 管理员刷新周总结 | OverviewScreen |
| GET/POST | `/api/summary-settings` | 读取/保存总结模式和目标 | SettingsHubScreen |
| GET/POST | `/api/ai-config` | 读取/加密保存 AI 端点、Key 和模型 | SettingsHubScreen |
| GET | `/api/health` | 连接测试 | MainActivity |

## DataStore 配置键

| 键 | 类型 | 默认值 | 说明 |
|----|------|--------|------|
| `server_url` | String | `""` | 服务器地址（必须 HTTPS） |
| `report_interval` | Int | `30` | 心跳间隔，秒（10-50） |
| `health_sync_interval` | Int | `15` | 健康同步间隔，分钟（15-60） |
| `enabled_health_types` | Set\<String\> | `emptySet()` | 启用的健康数据类型 |
| `monitoring_enabled` | Boolean | `false` | 心跳是否开启 |
| `capability_mode` | String | `"normal"` | 采集模式：normal / root / lsposed |
| `upload_location` | Boolean | `false` | 是否上传最近已知位置 |
| `upload_vpn_status` | Boolean | `false` | 是否上传 VPN 连接状态 |
| `upload_input_state` | Boolean | `false` | 是否上传输入状态布尔值 |
| `token`（加密） | String | `null` | 认证令牌（AES256-GCM） |
