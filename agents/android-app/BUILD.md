# Build Guide

## 环境要求

- **JDK**: 17+
- **Android SDK**: compileSdk 37, minSdk 26
- **Gradle**: 使用项目自带的 `gradlew` wrapper
- **IDE** (可选): Android Studio Hedgehog (2023.1.1) 或更新

## 构建步骤

```bash
cd agents/android-app
./gradlew assembleNormalDebug
./gradlew assemblePrivilegedDebug
```

APK 输出路径:

- 普通版: `app/build/outputs/apk/normal/debug/app-normal-debug.apk`
- Root/LSPosed 版: `app/build/outputs/apk/privileged/debug/app-privileged-debug.apk`

## 安装到手机

```bash
adb install -r app/build/outputs/apk/normal/debug/app-normal-debug.apk
```

或直接将 APK 传到手机安装。

## 项目结构

详见 [GUIDE.md](./GUIDE.md)。
