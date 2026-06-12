# LSPosed 实现交叉复核记录

复核日期：2026-06-12

复核范围：

- `app/src/privileged/java/com/monika/dashboard/lsposed/MonikaXposedModule.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspBrowserFeature.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspBrowserHookScope.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspBrowserTitle.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspBrowserActivityTitleHooks.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspBrowserTitleHooks.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspBrowserTitlePublisher.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspBrowserTitleReceiver.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspBrowserWebViewTitleHooks.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspDeviceFeedback.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspDeviceControlFeature.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspDeviceEnvironment.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspDirectConfig.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspDirectConfigReceiver.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspDirectFeature.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspDirectReportBuilder.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspDirectTransport.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspDirectUploader.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspForegroundFeature.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspForegroundHooks.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspForegroundReader.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspForegroundReporter.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspForegroundTitleState.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspHookSupport.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspMediaControllerTracker.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspMediaMetadata.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspMediaSessionRecordHooks.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspMediaState.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspMediaTracker.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspNotificationCenter.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspPackageController.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspRuntimeEnvironment.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspSupervisionCoordinator.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspSupervisionPolicy.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspSystemServerScope.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspViewerMessageBridge.java`
- `app/src/privileged/java/com/monika/dashboard/lsposed/LspWebSocketClient.java`
- `app/src/main/java/com/monika/dashboard/system/LsposedConfigBridge.kt`
- `app/src/privileged/java/com/monika/dashboard/system/LsposedBridgeReceiver.kt`
- `app/src/main/java/com/monika/dashboard/system/SystemSnapshot.kt`
- `app/src/main/java/com/monika/dashboard/network/ReportClient.kt`
- `app/src/main/java/com/monika/dashboard/service/HeartbeatWorker.kt`
- 本地 libxposed API：`E:/live/api/api/src/main/java/io/github/libxposed/api/`
- 本地 Android SDK 36：`E:/live/android-sdk/platforms/android-36/android.jar`
- AOSP：`frameworks/base` 当前 main 中 `ActivityTaskManagerService`、`RootWindowContainer`、`Task`、`TaskInfo`、`ActivityManager.TaskDescription`、`MediaSessionRecord`、`WebView`、`WebChromeClient`、`WebViewClient`
- AOSP Browser：`packages/apps/Browser` froyo 分支中的 `BrowserActivity`

## 结论

当前 LSP 实现总体方向正确：模块作用域包含 `system` 和浏览器包；system_server 负责前台、媒体、设备环境、设备命令和上传；浏览器进程只负责页面标题捕获并广播给 system_server。LSP 当前明确不采集键盘输入。已确认没有高频轮询：常规路径是 hook/系统回调驱动，5 分钟 heartbeat 只作为低频兜底。

本次修正了多个实际问题：

- 输入状态当前不采集；`onSystemServerStarting()` 明确跳过键盘输入 hook，避免噪声污染时间线语义。
- `MediaController` fallback 回调现在按 session token 保存，并在 session 消失或销毁时调用 `unregisterCallback`，避免旧媒体 session 回调泄漏/重复。
- 浏览器标题校验改为 API 34+ 优先使用 sender identity；低版本或拿不到 sender identity 时使用 nonce，所有版本仍做前台浏览器校验。
- 本轮拆分复查补回设备命令 receipt/result 的 WS ack 丢失兜底：WS `sendText()` 成功后如果服务端没有回 `device_command_*_received`，4 秒后仍会通过 `/api/supervision/ack` HTTP 提交同一 pending 事件。
- 普通 Android App 的设备命令 receipt/result 也补齐同一 4 秒兜底；WS 发送成功但 ack 丢失时，只要 pending 仍存在就会通过 `/api/supervision/ack` HTTP 提交，避免长期卡在本地队列。
- 本轮拆分复查收紧浏览器标题 receiver：未验证 sender identity 时必须有匹配的 `browser_title_nonce`，不再只靠“当前前台浏览器”接受广播。
- `LspPackageController.forceStopPackage()` 的两个 hidden API fallback 现在都围绕实际调用清理 Binder identity，与 `setPackagesSuspended` 路径一致。
- `LspDirectTransport` 统一通过 endpoint helper 裁剪 `server_url` 尾斜杠后再拼接 `/api/report`、`/api/messages` 和 `/api/supervision/ack`，避免不同配置来源导致 HTTP fallback 出现 `//api/...`。
- 去掉重复安装的 base `WebChromeClient#onReceivedTitle` hook，避免同一页面标题进入两条等价 hook 热路径。
- ATMS ready hook 改为优先 `onSystemReady`、兼容旧名 `systemReady`，与 AOSP main 当前方法名对齐。
- 前台变化不再只依赖 `moveTaskToFront` 和 5 分钟兜底；补充 hook ATMS `startActivityAsUser/setFocusedTask`、`RootWindowContainer#resumeFocusedTasksTopActivities`、`Task#resumeTopActivityUncheckedLocked`，并用 pending flag 合并短时间多次 resume 事件。
- WS 已连接后异常断开也会进入重连退避，避免边缘代理/服务端持续关闭时形成即时重连循环。
- App 侧普通 WebSocket 管理器的重连指数已封顶，避免长时间离线后位移溢出导致延迟计算异常。

## 生命周期与作用域

当前实现：

- `onModuleLoaded()` 保存实例与进程名。
- `onSystemServerStarting()` 交给 `LspSystemServerScope` 初始化上传线程、安装 media/foreground hooks 并调度 system_server receiver；输入 hook 明确跳过。
- `onPackageReady()` 交给 `LspBrowserFeature`，只对浏览器 UI 进程安装标题 hooks，并过滤 renderer/sandbox/gpu/service 等非 UI 子进程。

交叉验证：

- libxposed `package-info.java` 说明 `scope.list` 定义注入包，system_server 应使用特殊虚拟包名 `system`。
- libxposed `XposedModuleInterface.java` 说明 system_server 使用 `onSystemServerStarting()` 替代第一阶段 package load callback。
- `java_init.list` 指向 `com.monika.dashboard.lsposed.MonikaXposedModule`，`module.prop` 为 `minApiVersion=101` / `targetApiVersion=101` / `staticScope=true` / `exceptionMode=protective`。
- 当前 `scope.list` 同时包含 `system` 和 48 个浏览器包；脚本化集合比较确认它与 `LspBrowserTitle` 的浏览器包集合完全一致，没有“代码识别但未注入”或“注入但代码不识别”的包。

风险：

- 浏览器包列表是静态列表，小米/厂商浏览器若改包名仍需同时补 scope 和 `LspBrowserTitle`。

## 前台应用

当前实现：

- hook `ActivityTaskManagerService#onSystemReady` / `systemReady` 启动采样器；实现上优先匹配 AOSP 当前的 `onSystemReady`，旧 ROM/OEM 若保留 `systemReady` 也会 fallback。
- hook `ActivityTaskManagerService#moveTaskToFront`、`startActivityAsUser`、`setFocusedTask`，以及 `RootWindowContainer#resumeFocusedTasksTopActivities`、`Task#resumeTopActivityUncheckedLocked` 做事件触发。
- `LspForegroundReporter.snapshot()` 通过 `LspForegroundReader.topActivity()` 多策略读取顶部 Activity。
- 熄屏时跳过 ATMS 查询，直接报告 `sleeping`，避免息屏后保留旧前台应用。
- 前台事件触发会通过 `LspForegroundReporter.scheduleSnapshot()` 延迟 300-600ms 后读取，并用 pending flag 合并同一轮启动/恢复中的多次回调，避免 hook 热路径直接重复查询 ATMS。
- 前台 hook scope 已由 `LspForegroundFeature` 聚合；ATMS/RWC/Task 的前台事件 hook 安装、方法选择和 hook 结果判断已集中到 `LspForegroundHooks`；ATMS 读取、focused task / task list fallback、windowing mode 和设备形态判断已集中到 `LspForegroundReader`。
- 息屏/idle debounce、前台状态字段、状态广播、screen receiver、5 分钟 heartbeat fallback 和 `primaryDisplayTitle()` 展示文本已集中到 `LspForegroundReporter`；快照完成后的监督策略评估进入 `LspDeviceControlFeature`，system_server 启动和延迟注册编排已集中到 `LspSystemServerScope`。

交叉验证：

- AOSP `ActivityTaskManagerService` 存在 focused root task / focused stack / task list 这类路径；普通 Activity 启动/恢复还会经过 RootWindowContainer/Task resume 路径，因此只 hook `moveTaskToFront` 覆盖不完整。
- AOSP 官方当前 main 已核对：`ActivityTaskManagerService#startActivityAsUser` / `setFocusedTask`、`RootWindowContainer#resumeFocusedTasksTopActivities`、`Task#resumeTopActivityUncheckedLocked` 均存在，且 resume 方法返回 boolean 表示是否发生恢复动作。
- AOSP 官方当前 main 已核对：`TaskInfo` 包含 `topActivity`、`topActivityInfo`、`baseActivity`、`origActivity`、`taskDescription`；`ActivityManager.TaskDescription#getLabel()` 返回任务描述 label。
- 本地参考项目 EdgeX 也通过 `ActivityTaskManager.getService()` / `ServiceManager activity_task` 获取 ATMS。
- 小米兼容性：代码已读取 `miui.os.Build.IS_TABLET` 判断设备形态，并保留 `getTasks()` fallback。

风险：

- `RootWindowContainer` / `Task` 属于隐藏 system_server 实现，小米/HyperOS 可能改名或拆分；当前 hook 按类/方法名逐个保护安装，失败时仍保留低频 heartbeat 和 ATMS focused task 查询兜底。

## 输入状态

当前实现：

- 当前不安装 `InputMethodManagerService` hook。
- `onSystemServerStarting()` 明确记录“Keyboard input state is intentionally not collected”，避免把 IME 显隐、窗口焦点和实际输入行为混成不稳定时间线信号。

交叉验证：

- 现有 direct report 不再写入 `extra.input`；App 侧普通 fallback 仍按自身能力独立处理。
- 不安装输入 hook 后，LSP 热路径只保留前台、媒体、浏览器标题和系统 receiver。

已修正：

- 移除输入采集后，不再需要维护 `StartInputFlags` / `InputBindResult` 的隐藏 API 兼容分支。

## 媒体状态

当前实现：

- primary：system_server 内部 hook `com.android.server.media.MediaSessionRecord` / `$SessionStub` 的 `setPlaybackState`、`setMetadata`。
- fallback：`MediaSessionManager.addOnActiveSessionsChangedListener` + `MediaController.Callback`。
- `LspMediaTracker.validateIfNeeded()` 每 60 秒低频校验一次已记录媒体状态，避免后台媒体关闭后长时间显示播放中。
- 媒体入口保留在 `LspMediaTracker`；system_server 内部 `MediaSessionRecord` hook 已拆到 `LspMediaSessionRecordHooks`，公开 `MediaSessionManager` listener / `MediaController.Callback` fallback 已拆到 `LspMediaControllerTracker`，媒体状态字段和 snapshot 输出已收进 `LspMediaState`，媒体标题/作者/播放状态清洗收进 `LspMediaMetadata`；`MonikaXposedModule` 只通过 snapshot 参与前台标题、广播 extras 和 direct report。

交叉验证：

- AOSP 新版 `MediaSessionRecord#setMetadata` 签名已带额外参数；当前代码按方法名 hook，并从参数中查找 `MediaMetadata` / `PlaybackState`，对签名变化更稳。
- AOSP 当前 main 中 `MediaSessionRecord.SessionStub#setMetadata(MediaMetadata,long,String)` 会把 null metadata 传入 `sanitizeMediaMetadata()` 并保存为 null；`setPlaybackState(PlaybackState)` 也把 null state 视为 `STATE_NONE`，因此 fallback 路径必须能即时清空旧 metadata。
- AOSP 当前 main 中 `MediaSessionRecord#getPackageName()`、`getMetadata()`、`getPlaybackState()` 存在；代码优先调用方法，失败再读取字段候选。
- Android SDK 36 公开 API 确认 `MediaController.registerCallback(callback, handler)` 和 `unregisterCallback(callback)` 存在。
- 本地参考 SuperLyric、lyricon 都保存 callback wrapper，并在 session 变化/销毁时注销。

已修正：

- 旧 fallback 只保存 key，无法注销 callback。现在保存 `MediaControllerRegistration`，按 session token 清理失效回调，并处理 `onSessionDestroyed()`。
- system_server 内部 `MediaSessionRecord` hook 在收到播放状态但 metadata 为空/缺字段时会清空旧标题和作者，避免切歌、暂停、关闭后继续沿用上一首媒体标题。
- fallback listener 注册时会立即读取当前 active sessions，避免 LSP 启动/配置下发前已有媒体播放但没有新 callback 时漏报；`onMetadataChanged(null)` 也会按当前播放状态清空旧标题和作者。
- 媒体状态更新现在通过 `LspMediaState` 的同步方法集中写入，避免不同 callback 分散更新多个字段导致 snapshot 看到半更新状态；隐藏 hook 和公开 fallback 只通过同一个状态入口写入。

## 浏览器标题

当前实现：

- 浏览器进程 hook 由 `LspBrowserTitleHooks` 组合安装，并按 hook 范围拆分：
  - `LspBrowserActivityTitleHooks` 负责 Activity / TaskDescription / Window 标题信号
  - `Activity#setTitle(CharSequence/int)`
  - `Activity#setTaskDescription(TaskDescription)`
  - `Activity#onWindowFocusChanged`
  - `Window#setTitle`
  - `LspBrowserWebViewTitleHooks` 负责 WebChrome / WebViewClient / WebView 导航和 AOSP Browser 页面信号
  - `WebChromeClient#onReceivedTitle`
  - `WebViewClient#onPageFinished`
  - `WebView` 的 `loadUrl/postUrl/reload/goBack/goForward`
  - `WebView#setWebChromeClient` / `setWebViewClient` 后继续 hook 具体 client 子类
  - AOSP Browser `BrowserActivity#setUrlTitle(String,String)` 和 `onPageFinished(WebView,String)`
- `LspBrowserTitlePublisher` 负责标题清洗、泛标题过滤、进程内去重、Activity context 解析、nonce 附加和 `ACTION_BROWSER_TITLE` 广播。
- 浏览器进程通过 `ACTION_BROWSER_TITLE` 广播给 system_server，广播 action 由 publisher 和 receiver 共用同一个常量。
- system_server receiver 校验浏览器包名、API 34+ sender identity 或匹配的 nonce、当前或 2 秒内前台浏览器。

交叉验证：

- Android SDK 36 公开 API 确认 `BroadcastOptions#setShareIdentityEnabled`、`BroadcastReceiver#getSentFromPackage`、`Context#sendBroadcast(Intent,String,Bundle)` 存在。
- Android SDK 36 公开 API 确认 WebView/WebChromeClient/WebViewClient/Activity/Window 相关公开方法签名存在。
- AOSP 当前 main 已核对 `WebChromeClient#onReceivedTitle(WebView,String)`、`WebViewClient#onPageFinished(WebView,String)`、`WebView#getTitle()`、`loadUrl()`、`postUrl()`、`reload()`、`goBack()`、`goForward()`、`setWebViewClient()`、`setWebChromeClient()`。
- AOSP Browser froyo 分支已核对 `BrowserActivity#setUrlTitle(String,String)`、`onPageFinished(WebView,String)` 和 `resetTitleAndIcon(WebView)` 调用链；系统自带浏览器旧实现确实会从 WebView/Tab title 更新 Activity 标题。
- libxposed `getRemotePreferences()` 是框架远程偏好，hooked app 中只读；它不等同于 app 普通 SharedPreferences。因此浏览器进程不能被假定一定能读取 app 生成的 nonce。

已修正：

- `LsposedConfigBridge` 生成并下发 `browser_title_nonce`；API 34 以下或拿不到 sender identity 时，浏览器标题广播必须带相同 nonce。这样低版本不只依赖“当前前台浏览器”这个弱校验；本轮复查已确认 nonce 不匹配会直接拒绝。
- base `WebChromeClient#onReceivedTitle` 只安装一次；具体子类 hook 仍保留，用于处理 override 不调用 super 的浏览器实现。
- API 34+ 先验证 `BroadcastReceiver#getSentFromPackage()`；发送者身份已匹配时不再因为浏览器进程暂时读不到 nonce 而误拒绝标题广播。API 34 以下仍使用 nonce 与前台浏览器校验。
- 标题上报现在带 `source`，并过滤 `浏览器`、`Browser`、`New Tab`、应用名等泛标题。Activity/Window 的泛标题不能覆盖 WebView/AOSP 页面标题；WebView/AOSP 明确回报泛标题时会清空旧标题，避免显示上一页或“正在用浏览器看浏览器”。
- 浏览器标题会去掉浏览器名后缀、AOSP `URL: 标题`/`URL - 标题` 前缀，并丢弃纯 URL/host，避免把地址栏或应用名当作网页标题。
- system_server 维护浏览器标题来源优先级：WebView/WebChrome/AOSP 页面标题优先，TaskDescription 其次，Activity/Window/Focus 只做兜底；浏览器空标题会明确广播到 App 侧，防止 `SystemSnapshotStore` 合并时复活旧页面标题。
- 浏览器 hook 范围、浏览器进程 hook 和 system_server 标题 receiver 已由 `LspBrowserFeature` 聚合；浏览器进程 hook 安装入口保留在 `LspBrowserTitleHooks`，Activity/Window 标题 hook 拆到 `LspBrowserActivityTitleHooks`，WebView/WebChrome/WebViewClient/AOSP Browser 标题 hook、延迟读标题队列和具体 client 子类去重拆到 `LspBrowserWebViewTitleHooks`，浏览器进程内标题广播、nonce、Activity context 解析和去重拆到 `LspBrowserTitlePublisher`；system_server 侧标题广播注册、sender/nonce/前台浏览器校验和近期前台浏览器窗口已拆到 `LspBrowserTitleReceiver`；当前标题/source/更新时间和浏览器标题来源优先级已归入 `LspForegroundFeature` 内的 `LspForegroundTitleState`。`MonikaXposedModule` 只保留生命周期转发，监督策略评估交给 `LspDeviceControlFeature`。
- 动态 hook/反射支撑已抽到 `LspHookSupport`，集中类缓存、方法缓存、字段缓存、无参隐藏方法调用、候选无参方法/字段读取、按名称批量查找 overload、少量兼容方法选择缓存和 protective hook 包装；浏览器 hook 改为优先明确签名查找，AOSP Browser `setUrlTitle(String,String)` 也不再扫描全方法列表。

风险：

- `com.android.browser` / 小米浏览器可能不使用标准 WebView 或可能运行在厂商自定义 UI 进程。当前代码已覆盖 AOSP Browser 和常见 WebView/Activity 标题路径，但小米私有实现仍需要真机日志验证。

## 上传契约

LSP direct body：

- top-level：`app_id`、`window_title`、`timestamp`、`extra`
- `extra.device`：`profile=android_lsp`、`capabilities={freeze:true,unfreeze:true,vibrate:true,screen_off:false,say:true,risk_app_monitor:true,app_time_limit:true}`、`frozen_packages`、`last_sample_at`、`energy_policy=system_server_direct`、`min_interval_ms`、`device_kind`、可选 `window_mode`、网络/VPN 字段。`capability_mode` 只保留为 App 本地采集模式设置，不作为服务端上报契约。
- `extra.foreground`：`package_name`、`app_name`、`activity`、`title`、`source`、`confidence`
- `extra.media`：`playing`、`title`、`artist`、`app`、`package_name`、`state`、`source`
- `extra.input`：当前 LSP 不写入输入状态；普通 App fallback 可独立上报。

已修正：

- `LspForegroundReporter.primaryDisplayTitle()` 现在只有 `upload_media` 开启时才会把媒体状态拼进 `window_title`。关闭媒体上报时，媒体信息不会通过标题侧路继续显示。
- `/api/report` body 组装、capabilities、`offline_timeout_minutes`、`heartbeat_only` 签名和 foreground/media/device extras 契约已集中到 `LspDirectReportBuilder`；direct upload 配置、DPS/remote prefs 优先级、pending body 和 browser title nonce 已集中到 `LspDirectConfig`；配置广播注册、动态配置应用和清冻结命令已集中到 `LspDirectConfigReceiver`；上传节流、pending replay、设备命令 flush、report 构建和发送编排已集中到 `LspDirectUploader`；WS/HTTP 发送、HTTP fallback 消息轮询和设备命令事件回执已集中到 `LspDirectTransport`。
- `LspDirectTransport` 的 HTTP fallback endpoint 统一裁剪 `server_url` 尾斜杠，WS URL、report fallback、消息轮询和设备命令回执 fallback 使用同一 URL 规范化规则。
- `LspDirectFeature` 现在聚合 direct config、report builder、transport、uploader、viewer message bridge、device command controller 和 config receiver；`MonikaXposedModule` 只通过 `requestUpload()`、browser title nonce 和 direct config 状态参与直传链路，`LspSystemServerScope` 也只调 direct feature 的配置加载/注册入口。
- `LspDeviceControlFeature` 现在聚合包控制、监督策略和设备反馈；`frozen_packages`、冻结/解冻、`setPackagesSuspended` 兼容签名、force-stop fallback、受保护包判断和应用列表快照仍由 `LspPackageController` 实现，监督策略评估、风险复核 pending、检查定时、每日清理、风险冻结后打开网络设置仍由 `LspSupervisionCoordinator` 实现，通知/震动副作用仍由 `LspDeviceFeedback` 实现，但主模块和 direct 链路都只依赖设备控制功能入口。

交叉验证：

- `ReportClient.reportApp()` 使用同一套 `/api/report` 主体结构。
- `HeartbeatWorker` 在 LSPosed mode 只下发配置，不做 app 侧上传，避免双重上报；普通/root fallback 仍走 App 进程 WorkManager，并在 `extra.device.energy_policy` 中标记诊断信息。
- `LsposedBridgeReceiver` 的广播字段和 LSP intent extras 对齐，并写入 `SystemSnapshotStore`。

已修正：

- `SystemSnapshotStore.mergeForeground()` 现在只有同一 package/activity 才继承旧 title，避免切到其他 app 后继续显示旧浏览器标题。
- App 侧共享 `isActiveForegroundId()` / `isSleeping()`：`sleeping` 不会被当作活跃应用名，App fallback/普通上报会设置 `extra.sleeping=true`，与 LSP direct body 的息屏语义一致。

## 性能与稳定性

已确认：

- 没有高频轮询。前台 5 分钟、媒体 60 秒都是低频 stale guard。
- 上传只在 system_server 进程执行，浏览器进程不会直接联网上传。
- 息屏时 LSP 直传仍由 system_server 的 `ACTION_SCREEN_OFF` receiver 触发，普通 APK/WorkManager 路径不具备同等级保障，尤其在小米/HyperOS 后台冻结场景只能作为 fallback。
- WS 重连使用 30 秒到 5 分钟退避；断线时只调度一次 pending reconnect。
- WS 已连接后异常 EOF/close/ping/send 失败也会记录退避窗口，延迟触发下一次 snapshot/reconnect，避免服务端或边缘代理持续断开时自我放大。
- 普通 App `MessageSocketManager` 的指数退避固定封顶到 5 分钟，并限制 attempt 计数继续增长，避免长期断网后 `1L shl reconnectAttempts` 溢出。
- LSP 与普通 App 的设备命令 receipt/result 都是 WS 优先、HTTP 兜底：WS `send()` 成功后仍等待服务端 `device_command_*_received`，4 秒未收到且 pending 未删除时再 POST `/api/supervision/ack`，服务端账本按 `command_id`/`result_id` 去重。
- 网络、电量、VPN、音频输出和环境光读取已集中到 `LspDeviceEnvironment`，只在构建上报 body 时触发；环境光用短缓存和单次 listener，避免 hook 热路径持续采样。
- WS 客户端现在校验 HTTP 101 状态行、限制帧大小，并对扩展长度读取做 EOF 检查，避免代理异常或资源耗尽把连接伪装成成功。

仍需真机验证：

- 小米浏览器是否走标准 WebView/Activity/TaskDescription 标题路径。
- 内部 `MediaSessionRecord` 字段名在目标 ROM 上是否保留；fallback 已可工作但需要媒体切换/暂停/关闭真机日志验证。
- WebSocket 握手和断线恢复还需要真机/服务端继续观察，确认大帧、异常关闭和代理返回异常状态行不会误判。

## 方法级复核矩阵

以下矩阵按 LSP 模块当前 HEAD 的方法清单逐项归类。结论里的“通过”表示本地代码路径、字段契约、SDK 36/API 签名和 AOSP 对照未发现静态问题；“需真机”表示隐藏 API/OEM ROM 行为无法仅靠本地编译证明。
匿名内部类方法也计入覆盖：采样器 `run()` 归入采样器行；配置/息屏/浏览器标题 `onReceive()` 归入 receiver 行；媒体 callback 的 `onPlaybackStateChanged()`、`onMetadataChanged()`、`onSessionDestroyed()` 归入媒体 fallback 行。

| 范围 | 方法 | 复核结论 |
| --- | --- | --- |
| 生命周期 | `onModuleLoaded`、`onSystemServerStarting`、`onPackageReady`、`LspSystemServerScope.start`、`onForegroundSamplerStarted`、`LspBrowserFeature.handlePackageReady`、`LspBrowserHookScope.shouldHookBrowserProcess` | 通过。作用域和进程过滤与 LSPosed system/browser 双进程设计一致；system_server 启动和延迟 receiver/listener 注册已集中到 `LspSystemServerScope`；浏览器功能入口已集中到 `LspBrowserFeature`，包/进程过滤在 `LspBrowserHookScope`，renderer/gpu/service 子进程被排除。 |
| 前台 hook 安装 | `LspForegroundFeature.installHooks`、`LspForegroundHooks.install`、`moveTaskToFrontMethod`、`installForegroundResumeEventHooks`、`hookForegroundEventMethods`、`foregroundEventLikelyChanged`、`LspForegroundReporter.scheduleSnapshot` | 通过，需真机。AOSP 前台恢复路径覆盖 ATMS/RWC/Task，事件被 300-600ms 延迟和 pending flag 合并；前台 hook/reader/reporter/title state 已由 `LspForegroundFeature` 聚合，hook 范围和方法选择已拆到 `LspForegroundHooks`，状态读取和广播已拆到 `LspForegroundReporter`，小米若改类名会自动跳过并回退。 |
| 输入状态 | `onSystemServerStarting` 中的输入采集跳过分支 | 通过。当前 LSP 不安装输入 hook，不再维护 IME 隐藏 API 兼容分支。 |
| 采样器/receiver | `LspSystemServerScope.scheduleReceivers`、`LspForegroundFeature.registerScreenReceiver`、`snapshot`、`LspForegroundReporter.startSampler`、`registerScreenReceiver`、`snapshot`、`LspDirectFeature.loadConfig`、`registerConfigReceiver`、`LspDirectConfigReceiver.load`、`register`、`LspDeviceControlFeature.scheduleDailyCleanup`、`LspRuntimeEnvironment.initUploadThread`、`uploadHandler`、`LspBrowserFeature.registerReceiver`、`LspBrowserTitleReceiver.register` | 通过。无高频轮询；配置、息屏、浏览器标题 receiver 均在 system_server context 注册；延迟注册顺序和异常隔离已集中到 `LspSystemServerScope`；前台 heartbeat fallback、screen receiver 和状态广播已集中到 `LspForegroundFeature` / `LspForegroundReporter`；配置 receiver 注册和动态配置应用已集中到 `LspDirectConfigReceiver`，system_server 启动编排只依赖 `LspDirectFeature` 的配置入口；每日冻结清理只依赖 `LspDeviceControlFeature`；上传后台线程和 system_server 运行环境已集中到 `LspRuntimeEnvironment`；浏览器标题用 nonce/前台/发送者校验。 |
| 媒体 hook | `LspMediaTracker.installInternalHooks`、`LspMediaSessionRecordHooks.install`、`hookMediaSessionRecordMethod`、`updateMediaFromSessionRecord`、`mediaRecordFromHookThis`、`playbackStateFromRecord`、`metadataFromRecord`、`sessionRecordPackage` | 通过，需真机。方法名 hook 可兼容 AOSP 签名变化；字段名用多候选兜底；内部 `MediaSessionRecord` 兼容逻辑已集中到 `LspMediaSessionRecordHooks`，OEM 私有字段仍需设备验证。 |
| 媒体 fallback / snapshot | `LspMediaControllerTracker.initSessionListener`、`validateIfNeeded`、`handleActiveSessionsChanged`、`registerMediaControllerCallback`、`handlePlaybackStateChanged`、`handleMetadataChanged`、`mediaControllerKey`、`cleanupStaleMediaControllerCallbacks`、`unregisterMediaControllerCallback`、`refreshMediaFromControllers`、`refreshActiveMediaState`、`LspMediaState.snapshot`、`clear`、`setStopped`、`setPlaying`、`signature`、`LspMediaMetadata.title`、`artist`、`playbackStateName`、`Snapshot.putIntentExtras`、`Snapshot.putReportMedia` | 通过。SDK 36 `MediaController` callback/register/unregister 对照通过；callback 可注销，初始化会同步当前 active session，暂停/关闭/空 metadata 会清旧标题；公开 fallback 生命周期已集中到 `LspMediaControllerTracker`，状态写入和 snapshot 已集中到 `LspMediaState`，主模块只读取 immutable snapshot。 |
| 反射/hook 支撑 | `LspHookSupport.findClass`、`declaredMethodByName`、`declaredMethodsByName`、`declaredMethod`、`publicMethod`、`declaredMethodInHierarchy`、`invokeNoArg`、`invokeFirstNoArg`、`readField`、`readFirstField`、`readStaticField`、`cachedMethod`、`hookAfter`、`hookAfterResult` | 通过。类缓存、方法缓存、字段缓存和 protective hook 包装已从 `MonikaXposedModule` 抽到 `LspHookSupport`；主模块不再保留字段缓存或反射薄委托。需要兼容扫描的 `getTasks` / `setPackagesSuspended` 只在首次遇到对应类时执行，后续走缓存。 |
| 浏览器标题 hook | `LspBrowserFeature.handlePackageReady`、`registerReceiver`、`LspBrowserHookScope.handlePackageReady`、`shouldHookBrowserProcess`、`LspBrowserTitleHooks.install`、`LspBrowserActivityTitleHooks.install`、`hookActivityTitleText`、`hookActivityTitleResource`、`hookTaskDescription`、`hookWindowFocus`、`hookWindowTitle`、`LspBrowserWebViewTitleHooks.install`、`hookBaseWebChromeTitle`、`installWebViewTitleHooks`、`hookWebViewClientInstallers`、`hookSpecificWebChromeClient`、`hookSpecificWebViewClient`、`hookWebViewClientPageFinished`、`installAospBrowserTitleHooks`、`hookAospBrowserPageCallback`、`hookWebViewNavigation`、`scheduleWebViewTitleRead`、`publishTitleFromWebView`、`LspBrowserTitlePublisher.activityContext`、`publish`、`LspBrowserTitleReceiver.register`、`markForegroundBrowser`、`handleBroadcast`、`senderVerified`、`isForegroundBrowser`、`LspForegroundTitleState.apply`、`shouldApplyBrowserCandidate`、`LspBrowserTitle.isBrowserPackage`、`cleanBrowserTitle`、`sourceRank`、`isVolatileSource`、`isWebTitleSource`、`isGeneric`、`normalizeForCompare`、`cleanTitle` | 通过，需真机。SDK 36 Activity/WebView/WebChromeClient/WebViewClient/Window 签名已对照；AOSP Browser 私有方法已覆盖；浏览器 hook scope、进程 hook 和 system_server receiver 已由 `LspBrowserFeature` 聚合；浏览器包/进程作用域过滤已拆到 `LspBrowserHookScope`；浏览器标题安装入口保留在 `LspBrowserTitleHooks`，Activity/Window hook 拆到 `LspBrowserActivityTitleHooks`，WebView/AOSP hook、延迟读标题队列和具体 client 子类去重拆到 `LspBrowserWebViewTitleHooks`，标题发布、nonce、Activity context 解析和浏览器进程内去重拆到 `LspBrowserTitlePublisher`；system_server 侧广播注册、sender/nonce/前台校验和近期前台浏览器窗口已拆到 `LspBrowserTitleReceiver`；标题状态和来源优先级已归入 `LspForegroundFeature` 内的 `LspForegroundTitleState`；URL/host、浏览器后缀和泛标题清洗已拆到 `LspBrowserTitle`；Web/AOSP 标题优先于装饰性 Activity/Window/Focus 标题；小米浏览器私有 UI 进程仍需实测。 |
| 前台快照 | `LspForegroundFeature.snapshot`、`primaryDisplayTitle`、`LspForegroundReporter.snapshot`、`taskDescriptionIfNeeded`、`applyIdle`、`applyForeground`、`applyTaskTitleIfNeeded`、`sendStatus`、`primaryDisplayTitle`、`LspForegroundReader.topActivity`、`focusedTaskDescription`、`windowingMode`、`deviceFormFactor`、`activityTaskManagerService`、`compatibleGetTasksMethod`、`buildDefaultArgs`、`recentTopActivityFallback`、`LspRuntimeEnvironment.systemContext` | 通过，需真机。前台 reader/reporter/title state 已由 `LspForegroundFeature` 聚合；focused root/stack/getTasks 多策略覆盖已集中到 `LspForegroundReader`；熄屏/idle 状态、广播节流、状态广播、screen receiver 和展示标题已集中到 `LspForegroundReporter`；`ActivityThread` system context 缓存已集中到 `LspRuntimeEnvironment`；快照完成后由 `LspDeviceControlFeature` 评估监督策略，媒体 extras 由 `LspMediaTracker.Snapshot` 写入。 |
| 配置与上报 | `maybeDirectUpload`、`LspDirectFeature.requestUpload`、`browserTitleNonce`、`loadConfig`、`registerConfigReceiver`、`LspDirectConfigReceiver.load`、`register`、`apply`、`LspDirectConfig.load`、`applyFromBroadcast`、`setPendingBody`、`browserTitleNonce`、`LspDirectReportBuilder.build`、`capabilitiesJson`、`directOfflineTimeoutMinutes`、`shouldSendHeartbeatOnly`、`LspDirectUploader.request`、`upload`、`LspDirectTransport.sendReport`、`postDeviceCommandEvent`、`fetchQueuedMessagesFallback`、`readUtf8`、`LspDeviceEnvironment.putBatteryExtras`、`putNetworkExtras`、`putAudioOutputExtras`、`putAmbientLightExtras`、`isNetworkConnected`、`LspDeviceControlFeature.frozenPackagesJson` | 通过。HTTP/WS 共享 `/api/report` 契约；`LspDirectFeature` 聚合配置、上报、transport、viewer message 和 device command 的 composition root，主模块不再直接持有 direct 内部对象；配置状态、DPS/remote prefs 优先级、interval clamp、pending body 和 nonce 规范已集中到 `LspDirectConfig`；配置 receiver 注册、广播命令分支、配置应用、transport disconnect 和强制上传触发已集中到 `LspDirectConfigReceiver`；body 契约和 heartbeat-only 策略已集中到 `LspDirectReportBuilder`；上传节流、pending replay、设备命令 flush、report 构建和发送编排已集中到 `LspDirectUploader`；WS/HTTP 上报、HTTP fallback 消息轮询、设备命令事件回执和 256KB 读取上限已集中到 `LspDirectTransport`；设备环境 extras 已集中到 `LspDeviceEnvironment`，冻结状态通过 `LspDeviceControlFeature` 暴露。 |
| 包控制/冻结 | `LspDeviceControlFeature.frozenState`、`frozenPackages`、`freezePackage`、`unfreezePackage`、`isInstalledPackage`、`installedApps`、`frozenPackagesJson`、`isProtectedPackage`、`LspPackageController.frozenState`、`clear`、`setPackageSuspended`、`forceStopPackage` | 通过，需真机。冻结状态表、受保护包判断、隐藏 `setPackagesSuspended` 兼容签名和 force-stop fallback 已从主模块拆出；`setPackagesSuspended` 和 force-stop fallback 都会清 Binder identity 后再调用；主模块和 direct 链路只依赖 `LspDeviceControlFeature`，具体包冻结实现留在 `LspPackageController`；冻结/解冻通知副作用由 `LspDeviceFeedback` 执行。 |
| 监督策略编排 | `LspDeviceControlFeature.evaluateSupervision`、`scheduleDailyCleanup`、`clearSupervisionFreeze`、`nextDailyUnfreezeAt`、`shouldRequestReviewForReport`、`markReviewSentIfRequested`、`applySupervisionPolicy`、`finishPendingSupervisionReview`、`LspSupervisionCoordinator.applyPolicy`、`finishPendingReview`、`markReviewSentIfRequested`、`evaluate`、`scheduleDailyCleanup`、`clearFreeze`、`nextDailyUnfreezeAt`、`scheduleCheck`、`openNetworkSettingsIfOffline`、`LspSupervisionPolicy.applyPolicy`、`evaluate`、`shouldRequestReviewForReport`、`markReviewRequestSent`、`finishPendingReview` | 通过。策略规则/计时/冷却仍在 `LspSupervisionPolicy`；冻结副作用、风险复核 pending 上报标记、检查定时、每日清理和离线打开网络设置已集中到 `LspSupervisionCoordinator`；`LspDeviceControlFeature` 是外层功能入口，避免主模块和 direct feature 直接维护策略状态机或包控制细节。 |
| LSP WebSocket | `LspDirectTransport.ensureWsConnected`、`sendWsText`、`newWebSocketListener`、`scheduleWsReconnect`、`recordWsDisconnectedForBackoff`、`buildLspWsUrl`、`LspWebSocketClient.isConnected`、`connect`、`disconnect`、`sendText`、`sendStatusTextAndWaitAck`、`readerLoop`、`pingLoop`、`readFrame` | 通过。握手校验 101 和 `Sec-WebSocket-Accept`，client frame masked，帧大小 256KB；低层 WebSocket frame/ack 在 `LspWebSocketClient`，连接状态、重连退避、report WS 优先/HTTP fallback 在 `LspDirectTransport`，`LspDirectFeature` 负责把 WS 文本、HTTP fallback 消息和 device command 回执接回对应模块；真实代理关闭行为需观察。 |
| 消息转发/通知 | `LspViewerMessageBridge.handleWsTextMessage`、`forwardToApp`、`postNotification`、`LspDeviceControlFeature.postDeviceCommandSay`、`vibrate`、`LspDeviceFeedback.postSupervisionFreeze`、`postDeviceCommandSay`、`vibrate`、`cancelSupervisionFreeze`、`LspNotificationCenter.postViewerMessage`、`postSupervisionFreeze`、`postDeviceCommandSay`、`cancelSupervisionFreeze` | 通过。WS/HTTP fallback 的 `viewer_message` 字段转成 app receiver extras，`viewer_message.payload.type=device_command` 进入设备命令执行；viewer 消息解析、显式广播和通知触发已集中到 `LspViewerMessageBridge`；监督冻结通知、设备命令 say 通知和震动副作用已集中到 `LspDeviceFeedback`，并通过 `LspDeviceControlFeature` 对 direct/device command 链路暴露；通知渠道、稳定 notification id、launch pending intent 和 immutable flags 已集中到 `LspNotificationCenter`。 |
| 运行环境/工具 | `LspRuntimeEnvironment.onModuleLoaded`、`markSystemServer`、`processName`、`systemServerProcess`、`initUploadThread`、`uploadHandler`、`systemContext`、`isoTime`、`localClock`、`resolveAppLabel`、`screenInteractive`、`ignoredPackage`、`getBrowserTitleNonce` | 通过。进程身份、system_server 判断、上传线程、`ActivityThread` system context 缓存、应用标签、屏幕交互状态、忽略包列表和时间格式已从 `MonikaXposedModule` 拆到 `LspRuntimeEnvironment`；nonce 长度要求和懒加载仍由 `LspDirectConfig` 维护。 |
| App 侧交叉路径 | `LsposedConfigBridge.publish/getOrCreateBrowserTitleNonce`、`LsposedBridgeReceiver.handleStatus/handleMessage`、`SystemSnapshotStore.updateFromLsposed/mergeForeground/mergeMedia/clearForTest`、`isActiveForegroundId`、`isSleepingForeground`、`isSleeping`、`HeartbeatWorker.collectSystemSnapshot/buildStatusPayload`、`ReportClient.reportApp`、`DeviceCommandController.sendOrQueue/flushPendingEvents/scheduleHttpFallback`、`MessageSocketManager.scheduleReconnect` | 通过。配置字段、广播 extras、HTTP/WS payload 与服务端契约一致；浏览器空标题会覆盖旧标题；`sleeping` 不会被显示成“正在用sleeping”；普通 App WS 退避已封顶；普通 App 设备命令事件也与 LSP 一样在 WS ack 丢失时延迟 HTTP 兜底。 |

广播权限链：

- App 主 manifest 定义 `com.monika.dashboard.permission.LSPOSED_CONFIG` 为 signature 权限，并声明自身使用该权限。
- privileged receiver `LsposedBridgeReceiver` 要求同一权限；LSP 状态和消息广播均为显式 component，并使用 `CONFIG_PERMISSION` 作为 receiver permission。
- App -> system_server 的配置广播由 `LsposedConfigBridge` 使用同一权限发送；system_server 动态 config receiver 也以同一权限注册。

## 本地验证

已执行：

```powershell
.\gradlew.bat testPrivilegedDebugUnitTest --tests com.monika.dashboard.lsposed.LspDeviceCommandControllerTest --rerun-tasks
.\gradlew.bat detekt testNormalDebugUnitTest testPrivilegedDebugUnitTest assembleNormalDebug assemblePrivilegedDebug assembleNormalRelease assemblePrivilegedRelease --rerun-tasks
cd E:\live\live-dashboard-main\packages\backend
bun test tests/messages.test.ts tests/mcp-control.test.ts tests/ai-jobs.test.ts tests/ai-config.test.ts
bun run lint
```

结果：Android `BUILD SUCCESSFUL`；服务端协议/AI job/MCP 相关测试 44 pass，backend lint 通过。
