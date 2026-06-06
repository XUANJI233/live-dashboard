# LSPosed 实现交叉复核记录

复核日期：2026-06-05

复核范围：

- `app/src/privileged/java/com/monika/dashboard/lsposed/MonikaXposedModule.java`
- `app/src/main/java/com/monika/dashboard/system/LsposedConfigBridge.kt`
- `app/src/privileged/java/com/monika/dashboard/system/LsposedBridgeReceiver.kt`
- `app/src/main/java/com/monika/dashboard/system/SystemSnapshot.kt`
- `app/src/main/java/com/monika/dashboard/network/ReportClient.kt`
- `app/src/main/java/com/monika/dashboard/service/HeartbeatWorker.kt`
- 本地 libxposed API：`E:/live/api/api/src/main/java/io/github/libxposed/api/`
- 本地 Android SDK 36：`E:/live/android-sdk/platforms/android-36/android.jar`
- AOSP：`frameworks/base` 中 `ActivityTaskManagerService`、`InputMethodManagerService`、`MediaSessionRecord`

## 结论

当前 LSP 实现总体方向正确：模块作用域包含 `system` 和浏览器包；system_server 负责前台、输入、媒体、上传；浏览器进程只负责页面标题捕获并广播给 system_server。已确认没有高频轮询：常规路径是 hook/系统回调驱动，5 分钟 heartbeat 只作为低频兜底。

本次修正了多个实际问题：

- 输入状态不再在未知 `EditorInfo` 时默认报 active，改为优先解析 AOSP `StartInputFlags.IS_TEXT_EDITOR`，未知时保守 false。
- `MediaController` fallback 回调现在按 session token 保存，并在 session 消失或销毁时调用 `unregisterCallback`，避免旧媒体 session 回调泄漏/重复。
- 浏览器标题校验改为 API 34+ 优先使用 sender identity；低版本或拿不到 sender identity 时使用 nonce，所有版本仍做前台浏览器校验。
- 去掉重复安装的 base `WebChromeClient#onReceivedTitle` hook，避免同一页面标题进入两条等价 hook 热路径。
- ATMS ready hook 改为优先 `onSystemReady`、兼容旧名 `systemReady`，与 AOSP main 当前方法名对齐。
- 前台变化不再只依赖 `moveTaskToFront` 和 5 分钟兜底；补充 hook ATMS `startActivityAsUser/setFocusedTask`、`RootWindowContainer#resumeFocusedTasksTopActivities`、`Task#resumeTopActivityUncheckedLocked`，并用 pending flag 合并短时间多次 resume 事件。
- WS 已连接后异常断开也会进入重连退避，避免边缘代理/服务端持续关闭时形成即时重连循环。
- App 侧普通 WebSocket 管理器的重连指数已封顶，避免长时间离线后位移溢出导致延迟计算异常。

## 生命周期与作用域

当前实现：

- `onModuleLoaded()` 保存实例与进程名。
- `onSystemServerStarting()` 初始化上传线程，并安装 media、foreground、input hooks。
- `onPackageReady()` 只对浏览器包安装标题 hooks，并过滤 renderer/sandbox/gpu/service 等非 UI 子进程。

交叉验证：

- libxposed `package-info.java` 说明 `scope.list` 定义注入包，system_server 应使用特殊虚拟包名 `system`。
- libxposed `XposedModuleInterface.java` 说明 system_server 使用 `onSystemServerStarting()` 替代第一阶段 package load callback。
- `java_init.list` 指向 `com.monika.dashboard.lsposed.MonikaXposedModule`，`module.prop` 为 `minApiVersion=101` / `targetApiVersion=101` / `staticScope=true` / `exceptionMode=protective`。
- 当前 `scope.list` 同时包含 `system` 和 48 个浏览器包；脚本化集合比较确认它与 `BROWSER_PACKAGES` 完全一致，没有“代码识别但未注入”或“注入但代码不识别”的包。

风险：

- 浏览器包列表是静态列表，小米/厂商浏览器若改包名仍需补 scope 和 `BROWSER_PACKAGES`。

## 前台应用

当前实现：

- hook `ActivityTaskManagerService#onSystemReady` / `systemReady` 启动采样器；实现上优先匹配 AOSP 当前的 `onSystemReady`，旧 ROM/OEM 若保留 `systemReady` 也会 fallback。
- hook `ActivityTaskManagerService#moveTaskToFront`、`startActivityAsUser`、`setFocusedTask`，以及 `RootWindowContainer#resumeFocusedTasksTopActivities`、`Task#resumeTopActivityUncheckedLocked` 做事件触发。
- `broadcastSnapshot()` 通过 `getFocusedRootTaskInfo()`、`getFocusedStackInfo()`、`getTasks()` 多策略读取顶部 Activity。
- 熄屏时跳过 ATMS 查询，直接报告 `sleeping`，避免息屏后保留旧前台应用。
- 前台事件触发会通过 `scheduleForegroundSnapshot()` 延迟 300-600ms 后读取，并用 `foregroundSnapshotPending` 合并同一轮启动/恢复中的多次回调，避免 hook 热路径直接重复查询 ATMS。

交叉验证：

- AOSP `ActivityTaskManagerService` 存在 focused root task / focused stack / task list 这类路径；普通 Activity 启动/恢复还会经过 RootWindowContainer/Task resume 路径，因此只 hook `moveTaskToFront` 覆盖不完整。
- AOSP 官方当前 main 已核对：`ActivityTaskManagerService#startActivityAsUser` / `setFocusedTask`、`RootWindowContainer#resumeFocusedTasksTopActivities`、`Task#resumeTopActivityUncheckedLocked` 均存在，且 resume 方法返回 boolean 表示是否发生恢复动作。
- 本地参考项目 EdgeX 也通过 `ActivityTaskManager.getService()` / `ServiceManager activity_task` 获取 ATMS。
- 小米兼容性：代码已读取 `miui.os.Build.IS_TABLET` 判断设备形态，并保留 `getTasks()` fallback。

风险：

- `RootWindowContainer` / `Task` 属于隐藏 system_server 实现，小米/HyperOS 可能改名或拆分；当前 hook 按类/方法名逐个保护安装，失败时仍保留低频 heartbeat 和 ATMS focused task 查询兜底。

## 输入状态

当前实现：

- hook `InputMethodManagerService` 中的 start/show/hide 方法。
- `startInputOrWindowGainedFocus*` 优先解析 startInputFlags 中的 `IS_TEXT_EDITOR`。
- 补充 hook `onShowHideSoftInputRequested`，按第一个 boolean 参数同步 IME 显隐请求。

交叉验证：

- AOSP `InputMethodManagerService` 的 start input 路径会携带 `@StartInputFlags int startInputFlags`，并使用 `StartInputFlags.IS_TEXT_EDITOR` 区分文本编辑器焦点。
- 本地 Android SDK 36 公开 API 确认 `EditorInfo.inputType` 存在，但这不是当前 AOSP 判断文本编辑器的唯一依据。

已修正：

- 旧逻辑在没看到 `EditorInfo` 时返回 true，会把部分窗口焦点事件误判为输入中。现在未知签名返回 false，show/hide 事件仍会独立更新状态。
- `startInputOrWindowGainedFocus*` 现在会读取隐藏类 `InputBindResult` 的 `result` 码，不再把失败返回误判成输入激活。
- AOSP `InputBindResult` 当前分支中 0-4 与 16 是 success-ish 结果（含 IME session/binding、window focus only、user/accessibility 相关成功状态），错误结果字符串为 `ERROR_*`。当前代码按这些成功码放行，并用 `ERROR_` 字符串兜底，错误码不会激活输入状态。

## 媒体状态

当前实现：

- primary：system_server 内部 hook `com.android.server.media.MediaSessionRecord` / `$SessionStub` 的 `setPlaybackState`、`setMetadata`。
- fallback：`MediaSessionManager.addOnActiveSessionsChangedListener` + `MediaController.Callback`。
- `validateMediaStateIfNeeded()` 每 60 秒低频校验一次已记录媒体状态，避免后台媒体关闭后长时间显示播放中。

交叉验证：

- AOSP 新版 `MediaSessionRecord#setMetadata` 签名已带额外参数；当前代码按方法名 hook，并从参数中查找 `MediaMetadata` / `PlaybackState`，对签名变化更稳。
- AOSP 当前 main 中 `MediaSessionRecord.SessionStub#setMetadata(MediaMetadata,long,String)` 会把 null metadata 传入 `sanitizeMediaMetadata()` 并保存为 null；`setPlaybackState(PlaybackState)` 也把 null state 视为 `STATE_NONE`，因此 fallback 路径必须能即时清空旧 metadata。
- Android SDK 36 公开 API 确认 `MediaController.registerCallback(callback, handler)` 和 `unregisterCallback(callback)` 存在。
- 本地参考 SuperLyric、lyricon 都保存 callback wrapper，并在 session 变化/销毁时注销。

已修正：

- 旧 fallback 只保存 key，无法注销 callback。现在保存 `MediaControllerRegistration`，按 session token 清理失效回调，并处理 `onSessionDestroyed()`。
- system_server 内部 `MediaSessionRecord` hook 在收到播放状态但 metadata 为空/缺字段时会清空旧标题和作者，避免切歌、暂停、关闭后继续沿用上一首媒体标题。
- fallback listener 注册时会立即读取当前 active sessions，避免 LSP 启动/配置下发前已有媒体播放但没有新 callback 时漏报；`onMetadataChanged(null)` 也会按当前播放状态清空旧标题和作者。

## 浏览器标题

当前实现：

- 浏览器进程 hook：
  - `Activity#setTitle(CharSequence/int)`
  - `Activity#setTaskDescription(TaskDescription)`
  - `Activity#onWindowFocusChanged`
  - `Window#setTitle`
  - `WebChromeClient#onReceivedTitle`
  - `WebViewClient#onPageFinished`
  - `WebView` 的 `loadUrl/postUrl/reload/goBack/goForward`
  - `WebView#setWebChromeClient` / `setWebViewClient` 后继续 hook 具体 client 子类
  - AOSP Browser `BrowserActivity#setUrlTitle(String,String)` 和 `onPageFinished(WebView,String)`
- 浏览器进程通过 `ACTION_BROWSER_TITLE` 广播给 system_server。
- system_server receiver 校验浏览器包名、可选 nonce、API 34+ sender identity、当前或 2 秒内前台浏览器。

交叉验证：

- Android SDK 36 公开 API 确认 `BroadcastOptions#setShareIdentityEnabled`、`BroadcastReceiver#getSentFromPackage`、`Context#sendBroadcast(Intent,String,Bundle)` 存在。
- Android SDK 36 公开 API 确认 WebView/WebChromeClient/WebViewClient/Activity/Window 相关公开方法签名存在。
- libxposed `getRemotePreferences()` 是框架远程偏好，hooked app 中只读；它不等同于 app 普通 SharedPreferences。因此浏览器进程不能被假定一定能读取 app 生成的 nonce。

已修正：

- `LsposedConfigBridge` 生成并下发 `browser_title_nonce`；API 34 以下或拿不到 sender identity 时，浏览器标题广播必须带相同 nonce。这样低版本不只依赖“当前前台浏览器”这个弱校验。
- base `WebChromeClient#onReceivedTitle` 只安装一次；具体子类 hook 仍保留，用于处理 override 不调用 super 的浏览器实现。
- API 34+ 先验证 `BroadcastReceiver#getSentFromPackage()`；发送者身份已匹配时不再因为浏览器进程暂时读不到 nonce 而误拒绝标题广播。API 34 以下仍使用 nonce 与前台浏览器校验。
- 标题上报现在带 `source`，并过滤 `浏览器`、`Browser`、`New Tab`、应用名等泛标题。Activity/Window 的泛标题不能覆盖 WebView/AOSP 页面标题；WebView/AOSP 明确回报泛标题时会清空旧标题，避免显示上一页或“正在用浏览器看浏览器”。

风险：

- `com.android.browser` / 小米浏览器可能不使用标准 WebView 或可能运行在厂商自定义 UI 进程。当前代码已覆盖 AOSP Browser 和常见 WebView/Activity 标题路径，但小米私有实现仍需要真机日志验证。

## 上传契约

LSP direct body：

- top-level：`app_id`、`window_title`、`timestamp`、`extra`
- `extra.device`：`capability_mode=lsposed`、`uploader=lsposed`、`last_sample_at`、`device_kind`、可选 `window_mode`、网络/VPN 字段
- `extra.foreground`：`package_name`、`app_name`、`activity`、`title`、`source`、`confidence`
- `extra.media`：`playing`、`title`、`artist`、`app`、`package_name`、`state`、`source`
- `extra.input`：`input_active`、`is_typing`、`source`

已修正：

- `primaryDisplayTitle()` 现在只有 `upload_media` 开启时才会把媒体状态拼进 `window_title`。关闭媒体上报时，媒体信息不会通过标题侧路继续显示。

交叉验证：

- `ReportClient.reportApp()` 使用同一套 `/api/report` 主体结构。
- `HeartbeatWorker` 在 LSPosed mode 只下发配置，不做 app 侧上传，避免双重上报。
- `LsposedBridgeReceiver` 的广播字段和 LSP intent extras 对齐，并写入 `SystemSnapshotStore`。

已修正：

- `SystemSnapshotStore.mergeForeground()` 现在只有同一 package/activity 才继承旧 title，避免切到其他 app 后继续显示旧浏览器标题。

## 性能与稳定性

已确认：

- 没有高频轮询。前台 5 分钟、媒体 60 秒都是低频 stale guard。
- 上传只在 system_server 进程执行，浏览器进程不会直接联网上传。
- WS 重连使用 30 秒到 5 分钟退避；断线时只调度一次 pending reconnect。
- WS 已连接后异常 EOF/close/ping/send 失败也会记录退避窗口，延迟触发下一次 snapshot/reconnect，避免服务端或边缘代理持续断开时自我放大。
- 普通 App `MessageSocketManager` 的指数退避固定封顶到 5 分钟，并限制 attempt 计数继续增长，避免长期断网后 `1L shl reconnectAttempts` 溢出。
- 网络、电量、VPN 信息只在构建上报 body 时读取，不在 hook 热路径持续查询。
- WS 客户端现在校验 HTTP 101 状态行、限制帧大小，并对扩展长度读取做 EOF 检查，避免代理异常或资源耗尽把连接伪装成成功。

仍需真机验证：

- 小米/HyperOS 上 `InputMethodManagerService` start input 参数顺序是否与 AOSP 相同。
- 小米浏览器是否走标准 WebView/Activity/TaskDescription 标题路径。
- 内部 `MediaSessionRecord` 字段名在目标 ROM 上是否保留；fallback 已可工作但需要媒体切换/暂停/关闭真机日志验证。
- WebSocket 握手和断线恢复还需要真机/服务端继续观察，确认大帧、异常关闭和代理返回异常状态行不会误判。

## 方法级复核矩阵

以下矩阵按 `MonikaXposedModule.java` 当前 HEAD 的方法清单逐项归类。结论里的“通过”表示本地代码路径、字段契约、SDK 36/API 签名和 AOSP 对照未发现静态问题；“需真机”表示隐藏 API/OEM ROM 行为无法仅靠本地编译证明。

| 范围 | 方法 | 复核结论 |
| --- | --- | --- |
| 生命周期 | `onModuleLoaded`、`onSystemServerStarting`、`onPackageReady`、`shouldHookBrowserProcess` | 通过。作用域和进程过滤与 LSPosed system/browser 双进程设计一致；renderer/gpu/service 子进程被排除。 |
| 前台 hook 安装 | `installForegroundSampler`、`installForegroundResumeEventHooks`、`hookForegroundEventMethods`、`isNamed`、`foregroundEventLikelyChanged`、`scheduleForegroundSnapshot` | 通过，需真机。AOSP 前台恢复路径覆盖 ATMS/RWC/Task，事件被 300-600ms 延迟和 pending flag 合并；小米若改类名会自动跳过并回退。 |
| 输入 hook | `installInputMethodHooks`、`inputMethodHookKind`、`inputHookResultSucceeded`、`hasTextEditorInfo`、`startInputFlagsFromArgs`、`firstBooleanArg` | 通过，需真机。AOSP `StartInputFlags.IS_TEXT_EDITOR` 和 `InputBindResult` 码值已对照；小米参数顺序仍需日志确认。 |
| 采样器/receiver | `startForegroundSampler`、`registerConfigReceiver`、`initUploadThread`、`registerScreenStateReceiver`、`getUploadHandler`、`registerBrowserTitleReceiver` | 通过。无高频轮询；配置、息屏、浏览器标题 receiver 均在 system_server context 注册；浏览器标题用 nonce/前台/发送者校验。 |
| 媒体 hook | `installInternalMediaHooks`、`hookMediaSessionRecordMethod`、`updateMediaFromSessionRecord`、`mediaRecordFromHookThis`、`playbackStateFromRecord`、`metadataFromRecord`、`sessionRecordPackage` | 通过，需真机。方法名 hook 可兼容 AOSP 签名变化；字段名用多候选兜底；OEM 私有字段仍需设备验证。 |
| 媒体 fallback | `initMediaSessionListener`、`registerMediaControllerCallback`、`mediaControllerKey`、`cleanupStaleMediaControllerCallbacks`、`unregisterMediaControllerCallback`、`refreshMediaFromControllers`、`refreshActiveMediaState`、`validateMediaStateIfNeeded`、`clearMediaInfo`、`mediaInfoKey`、`mediaTextFromMeta` | 通过。SDK 36 `MediaController` callback/register/unregister 对照通过；callback 可注销，初始化会同步当前 active session，暂停/关闭/空 metadata 会清旧标题。 |
| 反射缓存 | `findMethod`、`findMethod(...paramTypes)`、`findPublicMethod`、`signatureOf`、`cachedClassForName`、`callAny`、`readField`、`readStaticField` | 通过。缓存命中/缺失均有 sentinel，避免反复反射；类加载器被纳入 class cache key。 |
| 浏览器标题 hook | `installActivityTitleHooks`、`installWebViewTitleHooks`、`hookWebViewClientInstallers`、`hookSpecificWebChromeClient`、`hookSpecificWebViewClient`、`hookWebViewClientPageFinished`、`installAospBrowserTitleHooks`、`hookAospBrowserPageCallback`、`hookWebViewNavigation`、`scheduleWebViewTitleRead`、`publishTitleFromWebView`、`findActivityContext`、`publishBrowserTitle`、`publishBrowserTitleFromProcess`、`cleanBrowserTitle`、`isGenericBrowserTitle`、`isWebTitleSource` | 通过，需真机。SDK 36 Activity/WebView/WebChromeClient/WebViewClient/Window 签名已对照；AOSP Browser 私有方法已覆盖；Android 14+ sender identity 通过时不再被 nonce 误拒；Activity/Window 泛标题不会覆盖 WebView/AOSP 页面标题；小米浏览器私有 UI 进程仍需实测。 |
| 前台快照 | `broadcastSnapshot`、`putMediaExtras`、`getTopActivityComponentName`、`componentFromTaskInfo`、`getTopActivityFromTasks`、`findCompatibleGetTasksMethod`、`buildDefaultArgs`、`getRecentTopActivityFallback`、`getFocusedTaskDescription`、`getWindowingMode`、`getDeviceFormFactor`、`getActivityTaskManagerService`、`getSystemContext` | 通过，需真机。focused root/stack/getTasks 多策略覆盖；熄屏跳过 ATMS；MIUI tablet 检测和 recent top fallback 存在。 |
| 配置与上报 | `loadDirectUploadConfig`、`saveDirectUploadConfig`、`maybeDirectUpload`、`sendDirectReport`、`clampDirectInterval`、`buildDirectReportBody`、`fillBatteryExtras`、`fillNetworkExtras`、`networkType`、`cellularGeneration`、`hasPhoneStatePermission`、`postDirectReportFallback`、`fetchQueuedMessagesFallback`、`readUtf8` | 通过。HTTP/WS 共享 `/api/report` 契约；网络/VPN/电量只在构建 payload 时读取；消息 fallback 有 256KB 读取上限。 |
| LSP WebSocket | `ensureWsConnected`、`scheduleWsReconnect`、`recordWsDisconnectedForBackoff`、`buildLspWsUrl`、`LspWebSocketClient.clearModuleClientIfCurrent`、`connect`、`disconnect`、`closeQuietly`、`sendText`、`sendCloseFrame`、`sendFrame`、`readerLoop`、`pingLoop`、`readFrame` | 通过。握手校验 101 和 `Sec-WebSocket-Accept`，client frame masked，帧大小 256KB，上下行异常进入退避；真实代理关闭行为需观察。 |
| 消息转发/通知 | `forwardViewerMessageToApp`、`postViewerMessageNotification` | 通过。WS/HTTP fallback 的 `viewer_message` 字段转成 app receiver extras；通知使用 app package launch intent 和 immutable pending intent。 |
| 展示文本/工具 | `primaryDisplayTitle`、`isoTime`、`playbackStateName`、`resolveAppLabel`、`firstNonBlank`、`safeString`、`normalizeNonce`、`getBrowserTitleNonce`、`isScreenInteractive`、`isIgnoredPackage`、`isBrowserPackage`、`cleanTitle` | 通过。`upload_media=false` 不再通过 `window_title` 泄露媒体；标题裁剪 256；nonce 长度要求 >=24。 |
| App 侧交叉路径 | `LsposedConfigBridge.publish/getOrCreateBrowserTitleNonce`、`LsposedBridgeReceiver.handleStatus/handleMessage`、`SystemSnapshotStore.updateFromLsposed/mergeForeground/mergeMedia`、`HeartbeatWorker.collectSystemSnapshot/buildStatusPayload`、`ReportClient.reportApp`、`MessageSocketManager.scheduleReconnect` | 通过。配置字段、广播 extras、HTTP/WS payload 与服务端契约一致；普通 App WS 退避已封顶。 |

广播权限链：

- App 主 manifest 定义 `com.monika.dashboard.permission.LSPOSED_CONFIG` 为 signature 权限，并声明自身使用该权限。
- privileged receiver `LsposedBridgeReceiver` 要求同一权限；LSP 状态和消息广播均为显式 component，并使用 `CONFIG_PERMISSION` 作为 receiver permission。
- App -> system_server 的配置广播由 `LsposedConfigBridge` 使用同一权限发送；system_server 动态 config receiver 也以同一权限注册。

## 本地验证

已执行：

```powershell
.\gradlew.bat :app:compilePrivilegedDebugJavaWithJavac :app:compilePrivilegedDebugKotlin
```

结果：BUILD SUCCESSFUL。

说明：首次沙箱内执行被 `D:/DevDeps/dev_cache/gradle/...zip.lck` 权限挡住；随后在用户授权的沙箱外执行同一条编译命令成功。
