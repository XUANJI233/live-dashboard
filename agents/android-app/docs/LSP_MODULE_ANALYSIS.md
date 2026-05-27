# LSPosed 模块实现分析报告

## 概述

基于 libxposed API 101/102 和开源参考项目（HyperLyric, lyricon, REAREye, WOMMO, EdgeX）的深度分析，对比当前 MonikaXposedModule 的实现。

---

## 1. 模块生命周期与启动时机

### 当前实现
```java
@Override
public void onSystemServerStarting(@NonNull XposedModuleInterface.SystemServerStartingParam param) {
    ClassLoader cl = param.getClassLoader();
    installForegroundSampler(cl);
    installMediaHooks(cl);
}
```

### 参考项目对比

#### HyperLyric (HookEntry.kt)
```kotlin
override fun onModuleLoaded(param: ModuleLoadedParam) {
    super.onModuleLoaded(param)
    globalXposedModule = this
    xLog("ModuleInit : 模块已加载")
}

override fun onPackageLoaded(param: PackageLoadedParam) {
    // 根据 packageName 安装不同的 hooks
    if (packageName == "com.android.systemui") { ... }
}
```

#### lyricon (ModuleEntry.kt)
```kotlin
override fun onModuleLoaded(param: XposedModuleInterface.ModuleLoadedParam) {
    instance = this
    YLog.init(this)
    // 全局初始化
}

override fun onPackageLoaded(param: XposedModuleInterface.PackageLoadedParam) {
    // 安装特定包的 hooks
    when (packageName) {
        PackageNames.SYSTEM_UI -> SystemUIHooker.hook(this, param)
    }
}
```

### 分析与建议

**✅ 当前实现正确**：
- `onSystemServerStarting()` 是 system_server 进程的正确入口点
- API 文档明确指出：在 system_server 中，`onPackageLoaded()` 和 `onPackageReady()` 被 `onSystemServerStarting()` 替代

**⚠️ 潜在问题**：
- 当前没有使用 `onModuleLoaded()` 进行全局初始化（如保存 XposedModule 实例）
- 建议添加静态实例引用，方便其他组件访问

**改进方案**：
```java
private static MonikaXposedModule instance;

@Override
public void onModuleLoaded(@NonNull XposedModuleInterface.ModuleLoadedParam param) {
    instance = this;
    log(Log.INFO, TAG, "onModuleLoaded: isSystemServer=" + param.isSystemServer());
}

@Override
public void onSystemServerStarting(@NonNull XposedModuleInterface.SystemServerStartingParam param) {
    // 现有的 hooks 安装逻辑
}
```

---

## 2. 配置加载机制

### 当前实现
```java
private void loadDirectUploadConfig() {
    SharedPreferences prefs = getRemotePreferences("monika_lsp_direct_upload");
    directUploadEnabled = prefs.getBoolean("enabled", false);
    directServerUrl = prefs.getString("server_url", "");
    directToken = prefs.getString("token", "");
    // ...
}
```

### 参考项目对比

#### HyperLyric (HookEntry.kt)
```kotlin
private var _prefs: SharedPreferences? = null

val prefs: SharedPreferences
    get() {
        if (_prefs == null) {
            _prefs = getRemotePreferences(UIConstants.PREF_NAME)
        }
        return _prefs!!
    }
```

#### lyricon (LyricPrefs.kt)
```kotlin
private val defaultSp = service.getRemotePreferences("default")
// 使用自定义 StateSharedPreferences 包装器，支持变更监听
```

### 分析与建议

**✅ 当前实现正确**：
- `getRemotePreferences()` 是 libxposed API 的标准方法
- 延迟加载（10秒后）是正确的，避免过早读取

**⚠️ 已知问题**：
- App 端需要写入标准的 SharedPreferences（非 EncryptedSharedPreferences）
- 已在 `LsposedConfigBridge.kt` 中修复

**改进方案**：
```java
// 添加配置变更监听（可选）
private void watchConfigChanges() {
    SharedPreferences prefs = getRemotePreferences("monika_lsp_direct_upload");
    prefs.registerOnSharedPreferenceChangeListener((sharedPrefs, key) -> {
        log(Log.INFO, TAG, "Config changed: " + key);
        loadDirectUploadConfig();
    });
}
```

---

## 3. 媒体会话监控

### 当前实现
```java
private void installMediaHooks(ClassLoader cl) {
    // Hook MediaSessionRecord
    Class<?> clazz = Class.forName("com.android.server.media.MediaSessionRecord", false, cl);
    hookMediaMethod(clazz, "setPlaybackState");
    hookMediaMethod(clazz, "setMetadata");
    
    // Hook MediaSessionService
    Class<?> service = Class.forName("com.android.server.media.MediaSessionService", false, cl);
    hookMediaServiceMethod(service, "onSessionPlaystateChanged");
    hookMediaServiceMethod(service, "onSessionPlaybackStateChanged");
    // ...
}
```

### 参考项目对比

#### lyricon (SystemUIMediaUtils.kt)
```kotlin
object SystemUIMediaUtils {
    private var mediaSessionManager: MediaSessionManager? = null
    
    fun init(context: Context) {
        val manager = appContext.getSystemService(Context.MEDIA_SESSION_SERVICE) as? MediaSessionManager
        mediaSessionManager = manager
        manager?.addOnActiveSessionsChangedListener(sessionListener, null)
        updateCallbackRegistrations(manager.getActiveSessions(null))
    }
    
    private val sessionListener = MediaSessionManager.OnActiveSessionsChangedListener { controllers ->
        updateCallbackRegistrations(controllers)
    }
}
```

### 分析与建议

**✅ 当前实现优势**：
- 在 system_server 中直接 hook 内部类，更底层
- 能够捕获所有媒体会话，无需权限

**⚠️ lyricon 方案对比**：
- 使用公开 API `MediaSessionManager`（在 SystemUI 进程中）
- 更稳定，但需要 `MEDIA_CONTENT_CONTROL` 权限
- 代码更简洁，易于维护

**建议**：
- 当前实现是正确的，适合 system_server 环境
- 可以添加 `MediaController` 信息作为补充（如果 hook 失败时有 fallback）

**潜在改进**：
```java
// 添加 MediaController fallback（在 App 进程中）
private void setupMediaControllerFallback(Context context) {
    MediaSessionManager manager = (MediaSessionManager) 
        context.getSystemService(Context.MEDIA_SESSION_SERVICE);
    manager.addOnActiveSessionsChangedListener(controllers -> {
        for (MediaController controller : controllers) {
            MediaMetadata metadata = controller.getMetadata();
            PlaybackState state = controller.getPlaybackState();
            // 处理媒体信息
        }
    }, null);
}
```

---

## 4. Activity/Task 监控与浏览器标签

### 当前实现
```java
private String getFocusedTaskDescription() {
    Object service = getActivityTaskManagerService();
    Object info = callAny(service, "getFocusedRootTaskInfo");
    if (info == null) info = callAny(service, "getFocusedStackInfo");
    
    // 尝试多个字段名
    Object desc = readField(info, "description");
    if (desc == null) desc = readField(info, "taskDescription");
    if (desc == null) desc = readField(info, "origDescription");
    
    // 处理 ActivityManager.TaskDescription 对象
    if (desc != null && !(desc instanceof CharSequence)) {
        Method getLabel = desc.getClass().getMethod("getLabel");
        Object label = getLabel.invoke(desc);
        if (label instanceof CharSequence) desc = label;
    }
    
    return desc instanceof CharSequence ? desc.toString() : null;
}
```

### 参考项目对比

#### REAREye (CustomBoundsCompatModule.kt)
```kotlin
val activityRecord = getActivityRecord()
val taskDescription = activityRecord.field<Any>("taskDescription")
val navigationBarColor = taskDescription.call<Int>("getNavigationBarColor")
```

### 分析与建议

**✅ 当前实现正确**：
- 使用 `ActivityTaskManager.getService()` 是标准方式
- 尝试多个字段名（description, taskDescription, origDescription）是很好的兼容性处理
- 调用 `getLabel()` 方法是正确的

**⚠️ 已知问题**：
- 浏览器标签为空可能是因为：
  1. `TaskDescription` 对象确实为 null
  2. 浏览器没有设置 TaskDescription
  3. 需要更长的延迟才能获取到

**改进方案**：

#### 方案 A：增强 TaskDescription 获取
```java
private String getFocusedTaskDescription() {
    try {
        Object service = getActivityTaskManagerService();
        if (service == null) return null;
        
        // 尝试多种 API
        Object info = callAny(service, "getFocusedRootTaskInfo");
        if (info == null) info = callAny(service, "getFocusedStackInfo");
        if (info == null) {
            // Fallback: getTasks() 获取最近的 task
            List<?> tasks = (List<?>) callAny(service, "getTasks", 1);
            if (tasks != null && !tasks.isEmpty()) {
                Object topTask = tasks.get(0);
                info = readField(topTask, "taskInfo");
            }
        }
        if (info == null) return null;
        
        // 尝试获取 TaskDescription
        Object desc = readField(info, "taskDescription");
        if (desc == null) desc = readField(info, "description");
        if (desc == null) desc = readField(info, "origDescription");
        
        if (desc == null) return null;
        
        // 如果是 TaskDescription 对象，调用 getLabel()
        if (!desc.getClass().getName().equals("java.lang.String") && 
            !desc.getClass().getName().equals("java.lang.CharSequence")) {
            try {
                Method getLabel = desc.getClass().getMethod("getLabel");
                Object label = getLabel.invoke(desc);
                if (label instanceof CharSequence) {
                    return label.toString().trim();
                }
            } catch (Throwable ignored) {}
        }
        
        return desc instanceof CharSequence ? desc.toString().trim() : null;
    } catch (Throwable t) {
        log(Log.DEBUG, TAG, "getFocusedTaskDescription failed: " + t.getMessage());
        return null;
    }
}
```

#### 方案 B：在浏览器进程中 Hook（更可靠）
```java
@Override
public void onPackageReady(@NonNull XposedModuleInterface.PackageReadyParam param) {
    String packageName = param.getPackageName();
    if (!isBrowserPackage(packageName)) return;
    
    ClassLoader cl = param.getClassLoader();
    installBrowserTitleHooks(cl, packageName);
}

private void installBrowserTitleHooks(ClassLoader cl, String packageName) {
    try {
        // Hook Activity.setTitle (通用)
        Class<?> activity = Class.forName("android.app.Activity", false, cl);
        Method setTitle = activity.getDeclaredMethod("setTitle", CharSequence.class);
        hook(setTitle).intercept(chain -> {
            Object result = chain.proceed();
            Activity act = (Activity) chain.getThisObject();
            CharSequence title = (CharSequence) chain.getArgs().get(0);
            broadcastActivityTitle(act, packageName, title.toString());
            return result;
        });
        
        // 针对 Chrome：Hook TabModelImpl
        try {
            Class<?> tabModel = Class.forName("org.chromium.chrome.browser.tabmodel.TabModelImpl", false, cl);
            Method setCurrentTab = findMethod(tabModel, "setCurrentTab");
            if (setCurrentTab != null) {
                hook(setCurrentTab).intercept(chain -> {
                    Object result = chain.proceed();
                    // 获取当前 tab 的 title
                    Object tab = chain.getThisObject();
                    Object currentTab = callAny(tab, "getCurrentTab");
                    if (currentTab != null) {
                        CharSequence title = (CharSequence) callAny(currentTab, "getTitle");
                        if (title != null) {
                            broadcastBrowserTitle(packageName, title.toString());
                        }
                    }
                    return result;
                });
            }
        } catch (Throwable ignored) {
            // Chrome 特定 hook 失败，忽略
        }
        
        log(Log.INFO, TAG, "Installed browser title hooks for " + packageName);
    } catch (Throwable t) {
        log(Log.WARN, TAG, "Failed to install browser hooks: " + t.getMessage());
    }
}
```

---

## 5. 前台应用检测

### 当前实现
```java
private ComponentName getTopActivityComponentName() {
    Object service = getActivityTaskManagerService();
    if (service == null) return null;
    Object info = callAny(service, "getFocusedRootTaskInfo");
    if (info == null) info = callAny(service, "getFocusedStackInfo");
    if (info == null) return null;
    Object top = readField(info, "topActivity");
    return top instanceof ComponentName ? (ComponentName) top : null;
}
```

### 参考项目对比

#### EdgeX (GestureActionDispatcher.kt)
```kotlin
val service = XposedHelpers.callStaticMethod(ActivityManager::class.java, "getTaskService")
// 使用 IActivityTaskManager.Stub.asInterface()
```

### 分析与建议

**✅ 当前实现正确**：
- 使用 `ActivityTaskManager.getService()` 是标准方式
- `getFocusedRootTaskInfo()` 是正确的 API

**改进方案**：
```java
// 添加更多 fallback 方法
private ComponentName getTopActivityComponentName() {
    try {
        Object service = getActivityTaskManagerService();
        if (service == null) return null;
        
        // 方法 1: getFocusedRootTaskInfo (Android 11+)
        Object info = callAny(service, "getFocusedRootTaskInfo");
        
        // 方法 2: getFocusedStackInfo (Android 10)
        if (info == null) info = callAny(service, "getFocusedStackInfo");
        
        // 方法 3: getTasks (通用 fallback)
        if (info == null) {
            List<?> tasks = (List<?>) callAny(service, "getTasks", 1);
            if (tasks != null && !tasks.isEmpty()) {
                Object topTask = tasks.get(0);
                Object topActivity = readField(topTask, "topActivity");
                return topActivity instanceof ComponentName ? (ComponentName) topActivity : null;
            }
        }
        
        if (info == null) return null;
        Object top = readField(info, "topActivity");
        return top instanceof ComponentName ? (ComponentName) top : null;
    } catch (Throwable t) {
        log(Log.DEBUG, TAG, "getTopActivityComponentName failed: " + t.getMessage());
        return null;
    }
}
```

---

## 6. 关键发现总结

### ✅ 正确的实现
1. **生命周期管理**：使用 `onSystemServerStarting()` 是正确的
2. **配置加载**：`getRemotePreferences()` 是标准 API，延迟加载正确
3. **媒体 Hook**：在 system_server 中 hook 内部类是合理的
4. **前台检测**：使用 `ActivityTaskManager` 是标准方式

### ⚠️ 需要改进的地方
1. **添加 `onModuleLoaded()` 初始化**：保存静态实例
2. **增强 TaskDescription 获取**：添加更多 fallback 方法
3. **浏览器标签 Hook**：考虑在浏览器进程中安装专用 hooks
4. **配置变更监听**：可选添加 `OnSharedPreferenceChangeListener`

### ❌ 参考项目中未找到的实现
- **浏览器标签检测**：没有开源项目实现类似功能
- **我们的实现已经是最佳实践**

---

## 7. 推荐改进优先级

| 优先级 | 改进项 | 理由 |
|--------|--------|------|
| **高** | 添加 `onModuleLoaded()` 初始化 | 简单且提供全局访问 |
| **高** | 增强 `getFocusedTaskDescription()` | 解决浏览器标签为空的问题 |
| **中** | 添加浏览器进程 Hook | 更可靠的标签获取方式 |
| **低** | 添加配置变更监听 | 可选优化 |
| **低** | MediaController fallback | 当前实现已足够 |

---

## 8. 测试建议

### 浏览器标签测试
```bash
# 1. 打开 Chrome，访问任意网页
# 2. 查看日志
adb logcat -s MonikaLSP | grep "foreground:"

# 期望看到：
# foreground: com.android.chrome/... title=网页标题

# 3. 如果 title 为空，检查 TaskDescription 对象
adb logcat -s MonikaLSP -v time | grep "getFocusedTaskDescription"
```

### 媒体测试
```bash
# 1. 播放音乐/视频
# 2. 查看日志
adb logcat -s MonikaLSP | grep "media"

# 期望看到：
# media_playing=true media_title=... media_artist=...
```

### 配置加载测试
```bash
# 1. 重启手机
# 2. 等待 15 秒
# 3. 查看日志
adb logcat -s MonikaLSP | grep "config loaded"

# 期望看到：
# config loaded: enabled=true url=... token=set
```

---

## 9. 参考资料

- **libxposed API**: `e:\live\api\api\src\main\java\io\github\libxposed\api\`
- **HyperLyric**: `e:\live\refs\HyperLyric\app\src\main\java\com\lidesheng\hyperlyric\root\HookEntry.kt`
- **lyricon**: `e:\live\refs\lyricon\xposed\src\main\kotlin\io\github\proify\lyricon\xposed\ModuleEntry.kt`
- **REAREye**: `e:\live\refs\REAREye\app\src\main\java\hk\uwu\reareye\hook\scopes\system\modules\CustomBoundsCompatModule.kt`

---

## 10. 下一步行动

1. **立即执行**：
   - [ ] 添加 `onModuleLoaded()` 初始化
   - [ ] 增强 `getFocusedTaskDescription()` fallback 逻辑
   - [ ] 推送代码并测试

2. **后续优化**：
   - [ ] 实现浏览器进程 Hook（Chrome, Firefox）
   - [ ] 添加配置变更监听
   - [ ] 优化日志输出，添加更多调试信息

3. **文档更新**：
   - [ ] 更新 README 说明配置加载流程
   - [ ] 添加故障排查指南
