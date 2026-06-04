# LSPosed loads the module entry from META-INF/xposed/java_init.list and calls
# lifecycle methods reflectively. Keep the original class name and members in
# release builds; debug works without this because R8/minify is disabled.
-adaptresourcefilecontents META-INF/xposed/java_init.list
-keep class com.monika.dashboard.lsposed.MonikaXposedModule { *; }
-keep class com.monika.dashboard.lsposed.MonikaXposedModule$* { *; }
-keepattributes InnerClasses,EnclosingMethod,Signature,*Annotation*
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

# WorkManager keeps its scheduler state in an internal Room database. Some
# release/R8 combinations can strip or optimize the generated no-arg database
# implementation constructor, causing WorkManager.getInstance() to fail only in
# release builds when scheduling starts from the settings screen.
-keep class androidx.work.impl.WorkDatabase_Impl { *; }
-keep class androidx.work.impl.model.** { *; }
