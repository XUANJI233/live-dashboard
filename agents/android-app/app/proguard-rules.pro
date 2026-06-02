# LSPosed module entry and metadata must survive R8 in release builds.
-adaptresourcefilecontents META-INF/xposed/java_init.list
-keep,allowobfuscation,allowoptimization class * extends io.github.libxposed.api.XposedModule {
    public void onModuleLoaded(...);
    public void onPackageLoaded(...);
    public void onPackageReady(...);
    public void onSystemServerStarting(...);
}
-keepclassmembers,allowoptimization class ** implements io.github.libxposed.api.XposedInterface$Hooker {
    public <init>(...);
}

# BroadcastReceiver：LSPosed 模块通过 explicit ComponentName（字符串类名）发送广播，
# R8 会把类名混淆导致 ComponentName 解析失败，必须保留原名。
-keep class com.monika.dashboard.system.LsposedBridgeReceiver { *; }

# LSPosed ↔ app 桥接数据类：SystemSnapshot 及其关联类型在 LSPosed 模块和
# app 之间传递，被 ReportClient/HeartbeatWorker 等多处使用，保留以防 R8 误删。
-keep class com.monika.dashboard.system.SystemSnapshot { *; }
-keep class com.monika.dashboard.system.ForegroundInfo { *; }
-keep class com.monika.dashboard.system.InputInfo { *; }
-keep class com.monika.dashboard.system.MediaInfo { *; }
-keep class com.monika.dashboard.system.LocationSnapshot { *; }
