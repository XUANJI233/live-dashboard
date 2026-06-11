# Live Dashboard — Windows Agent

监控前台窗口并向 Live Dashboard 后端上报应用使用状态，支持系统托盘常驻运行。

## 快速开始

从 [GitHub Releases](https://github.com/Monika-Dream/live-dashboard/releases) 下载 `live-dashboard-agent.exe`，将 `config.json` 放在同目录下，双击运行即可。

## 从源码运行

**需要**: Python 3.10+

1. 安装依赖：
   ```bash
   pip install -r requirements.txt
   ```
2. 复制 `config.example.json` 为 `config.json`，填入你的信息：
   ```json
   {
     "server_url": "https://your-domain.com",
     "token": "你的设备密钥",
     "interval_seconds": 5,
     "heartbeat_seconds": 60,
     "idle_threshold_seconds": 300,
     "enable_log": false
   }
   ```
3. 运行：
   ```bash
   python agent.py
   ```

## 打包为 .exe

运行 `build.bat`，会用 PyInstaller 打包为单文件 `dist/live-dashboard-agent.exe`，随后用 Authenticode 签名并验证签名。

将 `config.json` 放在 `.exe` 同目录下即可运行。

WinUI 3 迁移工作位于 `agents/windows-winui`。该目录先承载新的原生 Windows UI、注册表配置、自启动清理和便携/当前用户安装双模式构建；当前 Python Agent 仍保留在本目录，直到采集和 API 运行时逐步迁移完成。

### Windows 代码签名

Release 版优先使用可信 Authenticode 证书签名，避免 PyInstaller 单文件程序被 SmartScreen 或杀毒软件更容易误判。没有付费/可信证书时，可以显式选择自签名或跳过签名；这两种方式都不等于可信发布者。

可用的签名配置：

- `WINDOWS_CODESIGN_CERT_BASE64`：PFX 证书的 base64 内容，适合 GitHub Actions secrets。
- `WINDOWS_CODESIGN_CERT_PATH`：本机 PFX 文件路径，适合本地发布机。
- `WINDOWS_CODESIGN_CERT_THUMBPRINT`：已安装到证书存储的代码签名证书指纹。
- `WINDOWS_CODESIGN_CERT_PASSWORD`：PFX 密码。
- `WINDOWS_SIGNTOOL_PATH`：可选，手动指定 `signtool.exe`。
- `WINDOWS_TIMESTAMP_URL`：可选，默认 `http://timestamp.digicert.com`。
- `WINDOWS_SELF_SIGN`：没有可信证书时，设置为 `true` 会临时生成自签名 Code Signing 证书并嵌入 Authenticode 签名。

自签名不需要付费证书，但用户机器默认不信任，仍可能显示未知发布者。它只比完全未签名更利于标识构建来源，不能保证绕过 SmartScreen 或杀软误判。

本地临时调试如果确实要完全跳过签名，必须显式设置：

```powershell
$env:WINDOWS_SKIP_SIGNING = "true"
.\build.bat
```

只允许使用字符串 `true` / `false`，不要用 `1` / `0`。

GitHub Actions 使用 `.github/workflows/windows-agent.yml` 构建 Windows artifact。发布用仓库 secret：

- `WINDOWS_CODESIGN_CERT_BASE64`
- `WINDOWS_CODESIGN_CERT_PASSWORD`

可选仓库 variable：

- `WINDOWS_TIMESTAMP_URL`

手动 workflow 里可以选择 `skip_signing=true` 生成 unsigned debug artifact；正式 tag 构建会要求签名。`build.bat` 默认不暂停，只有本地需要保留窗口时才设置 `WINDOWS_BUILD_PAUSE=true`。

当前 GitHub workflow 的策略：

- `windows-source` 分支 push：构建 unsigned debug artifact，用来验证编译、测试和打包。
- `windows-agent-*` tag：优先使用可信证书 secrets；没有 secrets 时默认生成自签名 Authenticode artifact。
- 手动 workflow：默认允许自签名；如果只想做最快 smoke，可选 `skip_signing=true`。

## 开机自启

推荐从托盘右键菜单直接切换“开机自启”。菜单会写入当前用户的登录启动项，不需要管理员权限，也不会把托盘窗口放进高权限/非交互环境。

如果必须使用任务计划，将 `.exe` 和 `config.json` 放在固定目录后运行 `install-task.bat`。脚本会创建登录时启动的普通权限任务；旧版 `LiveDashboardAgent` 最高权限任务会在托盘菜单关闭自启时尝试清理。

## 配置说明

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `server_url` | 后端地址 | 必填 |
| `token` | 设备密钥（部署服务端时生成的） | 必填 |
| `interval_seconds` | 上报间隔（秒） | `5` |
| `heartbeat_seconds` | AFK 时心跳间隔（秒） | `60` |
| `idle_threshold_seconds` | 无操作多久后进入 AFK 模式（秒） | `300` |

## 功能

### 系统托盘

启动后常驻系统托盘，图标颜色反映当前状态（绿色=在线，灰色=AFK/离线）。

右键菜单：
- 查看当前状态和正在使用的应用
- 单击/双击托盘图标打开主界面
- 开关日志文件
- 开关开机自启
- 打开设置（编辑服务器地址、Token、上报间隔等）
- 安全退出

### 主界面

Windows Agent 使用单一主窗口，信息架构与手机端管理工具保持一致：

- `概览`：显示后台状态、当前上报目标、服务器和自启动状态。
- `消息`：查看服务器消息、AI 监督提醒和桌面设备命令文本。
- `设置`：修改服务器地址、Token、上报间隔、心跳间隔、AFK 判定、日志和自启动。

主界面由一个 tkinter UI 控制器统一管理，托盘、二次启动唤醒和消息提醒都会回到同一个窗口，避免多套弹窗互相抢焦点或无法关闭。

UI 结构拆分为：

- `ui_components.py`：卡片、导航、状态标签、按钮网格和偏好项等设计系统原语。
- `ui_layout.py`：响应式布局决策，窗口较窄时卡片自动回落为单列，避免字段和按钮挤压。
- `ui_messages.py`：消息摘要、详情和去重格式化。
- `ui_app.py`：只负责窗口生命周期、事件队列和页面拼装。

后台、托盘动作和配置表单校验产生的提示都会显示为主窗口顶部的非模态提示条，不依赖隐藏窗口上的阻塞式弹窗。

当前 UI 保持 Python/tkinter + pystray + Win32 API 组合，不额外引入 Electron、Qt、Go/C++ 重写或其它桌面 SDK。原因是现有托盘、单实例唤醒、开机自启和 PyInstaller 打包链路已经满足常驻 Agent 需求；引入大型 UI 运行时会增加内存占用、签名/杀软误报和发布复杂度。

### 前台应用检测

实时检测当前前台窗口的应用和标题，通过 Win32 API 获取进程信息。

### 音乐检测

自动识别 Spotify、QQ音乐、网易云、foobar2000、酷狗、酷我、AIMP 等播放器，从窗口标题解析正在播放的歌曲信息。

### 电量上报

笔记本自动上报电池电量和充电状态，台式机不显示（正常行为）。

### AFK 检测

无键鼠输入超过阈值（默认 300 秒）后进入 AFK 模式，切换为低频心跳上报。

**视频/音频免 AFK**：当检测到以下情况时，即使键鼠空闲也不会进入 AFK：
- 系统有活跃音频流（通过 pycaw 检测，覆盖所有播放器和浏览器视频）
- 前台窗口处于全屏状态（通过 Win32 API 比对窗口尺寸与屏幕分辨率）

典型场景：看视频、听音乐、全屏演示时不会被标记为 AFK。

### 日志

运行日志自动写入 `agent.log`，按天轮转保留 2 天。

### 服务端设备命令

Windows 端会显式上报 `desktop_message` 能力：

```json
{
  "profile": "desktop_message",
  "capabilities": {
    "freeze": false,
    "unfreeze": false,
    "vibrate": false,
    "screen_off": false,
    "say": true,
    "risk_app_monitor": false,
    "app_time_limit": false
  }
}
```

服务端下发统一 `device_command` 时，Windows Agent 只执行桌面文本提醒 `say`，并通过 WebSocket 或 `/api/supervision/ack` 回传 `device_command_receipt` / `device_command_result`。冻结、解冻、震动、息屏和 LSP 监督策略会被标记为不支持，不会在 Windows 上执行。

## 技术栈

- **Win32 API**: 前台窗口检测、空闲时间、全屏检测
- **pystray + Pillow**: 系统托盘图标和菜单
- **pycaw**: Windows Core Audio API，检测活跃音频会话
- **psutil**: 电池信息
- **tkinter**: 单窗口主界面、设置和消息视图（Python 内置）
- **websocket-client**: 设备 WebSocket、留言和设备命令回执
