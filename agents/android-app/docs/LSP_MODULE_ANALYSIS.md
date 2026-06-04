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

本次修正了三个实际问题：

- 输入状态不再在未知 `EditorInfo` 时默认报 active，改为优先解析 AOSP `StartInputFlags.IS_TEXT_EDITOR`，未知时保守 false。
- `MediaController` fallback 回调现在按 session token 保存，并在 session 消失或销毁时调用 `unregisterCallback`，避免旧媒体 session 回调泄漏/重复。
- 浏览器标题 nonce 改为“带 nonce 则校验；缺失不直接拒绝”，避免浏览器进程无法读取 app 普通 SharedPreferences 时被误拦截。API 34+ 仍使用 sender identity，所有版本仍做前台浏览器校验。
- 去掉重复安装的 base `WebChromeClient#onReceivedTitle` hook，避免同一页面标题进入两条等价 hook 热路径。

## 生命周期与作用域

当前实现：

- `onModuleLoaded()` 保存实例与进程名。
- `onSystemServerStarting()` 初始化上传线程，并安装 media、foreground、input hooks。
- `onPackageReady()` 只对浏览器包安装标题 hooks，并过滤 renderer/sandbox/gpu/service 等非 UI 子进程。

交叉验证：

- libxposed `package-info.java` 说明 `scope.list` 定义注入包，system_server 应使用特殊虚拟包名 `system`。
- libxposed `XposedModuleInterface.java` 说明 system_server 使用 `onSystemServerStarting()` 替代第一阶段 package load callback。
- 当前 `scope.list` 同时包含 `system` 和浏览器包，符合“system_server 采集 + 浏览器进程标题 hook”的设计。

风险：

- 浏览器包列表是静态列表，小米/厂商浏览器若改包名仍需补 scope 和 `BROWSER_PACKAGES`。

## 前台应用

当前实现：

- hook `ActivityTaskManagerService#systemReady` 启动采样器。
- hook `ActivityTaskManagerService#moveTaskToFront` 做事件触发。
- `broadcastSnapshot()` 通过 `getFocusedRootTaskInfo()`、`getFocusedStackInfo()`、`getTasks()` 多策略读取顶部 Activity。
- 熄屏时跳过 ATMS 查询，直接报告 `sleeping`，避免息屏后保留旧前台应用。

交叉验证：

- AOSP `ActivityTaskManagerService` 存在 focused root task / focused stack / task list 这类路径，但隐藏 API 和 ROM 差异较大。
- 本地参考项目 EdgeX 也通过 `ActivityTaskManager.getService()` / `ServiceManager activity_task` 获取 ATMS。
- 小米兼容性：代码已读取 `miui.os.Build.IS_TABLET` 判断设备形态，并保留 `getTasks()` fallback。

风险：

- `moveTaskToFront` 不是所有前台切换的唯一入口。当前 5 分钟兜底能防止长期错误，但普通 Activity 启动可能仍依赖 focused task 查询时机。若后续要进一步提高实时性，应继续验证 AOSP `ActivityRecord`/`RootWindowContainer` 的 resume 事件，不应改成高频轮询。

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

## 媒体状态

当前实现：

- primary：system_server 内部 hook `com.android.server.media.MediaSessionRecord` / `$SessionStub` 的 `setPlaybackState`、`setMetadata`。
- fallback：`MediaSessionManager.addOnActiveSessionsChangedListener` + `MediaController.Callback`。
- `validateMediaStateIfNeeded()` 每 60 秒低频校验一次已记录媒体状态，避免后台媒体关闭后长时间显示播放中。

交叉验证：

- AOSP 新版 `MediaSessionRecord#setMetadata` 签名已带额外参数；当前代码按方法名 hook，并从参数中查找 `MediaMetadata` / `PlaybackState`，对签名变化更稳。
- Android SDK 36 公开 API 确认 `MediaController.registerCallback(callback, handler)` 和 `unregisterCallback(callback)` 存在。
- 本地参考 SuperLyric、lyricon 都保存 callback wrapper，并在 session 变化/销毁时注销。

已修正：

- 旧 fallback 只保存 key，无法注销 callback。现在保存 `MediaControllerRegistration`，按 session token 清理失效回调，并处理 `onSessionDestroyed()`。

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

- nonce 不再强制必须存在。缺失时依赖 sender identity 与前台浏览器校验；携带 nonce 但不匹配时仍拒绝。
- base `WebChromeClient#onReceivedTitle` 只安装一次；具体子类 hook 仍保留，用于处理 override 不调用 super 的浏览器实现。

风险：

- `com.android.browser` / 小米浏览器可能不使用标准 WebView 或可能运行在厂商自定义 UI 进程。当前代码已覆盖 AOSP Browser 和常见 WebView/Activity 标题路径，但小米私有实现仍需要真机日志验证。

## 上传契约

LSP direct body：

- top-level：`app_id`、`window_title`、`timestamp`、`extra`
- `extra.device`：`capability_mode=lsposed`、`uploader=lsposed`、`last_sample_at`、`device_kind`、可选 `window_mode`、网络/VPN 字段
- `extra.foreground`：`package_name`、`app_name`、`activity`、`title`、`source`、`confidence`
- `extra.media`：`playing`、`title`、`artist`、`app`、`package_name`、`state`、`source`
- `extra.input`：`input_active`、`is_typing`、`source`

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
- 网络、电量、VPN 信息只在构建上报 body 时读取，不在 hook 热路径持续查询。

仍需真机验证：

- 小米/HyperOS 上 `InputMethodManagerService` start input 参数顺序是否与 AOSP 相同。
- 小米浏览器是否走标准 WebView/Activity/TaskDescription 标题路径。
- 内部 `MediaSessionRecord` 字段名在目标 ROM 上是否保留；fallback 已可工作但需要媒体切换/暂停/关闭真机日志验证。

## 本地验证

已执行：

```powershell
.\gradlew.bat :app:compilePrivilegedDebugJavaWithJavac :app:compilePrivilegedDebugKotlin
```

结果：BUILD SUCCESSFUL。

说明：首次沙箱内执行被 `D:/DevDeps/dev_cache/gradle/...zip.lck` 权限挡住；随后在用户授权的沙箱外执行同一条编译命令成功。
