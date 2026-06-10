# Live Dashboard — macOS Agent 源码

> `macos-source` 分支 — macOS 桌面端 Agent 源码
>
> 服务端部署、前端功能、API 参考等通用文档请参阅 [`main` 分支 README](https://github.com/Monika-Dream/live-dashboard/tree/main#readme)。

> **注意**：macOS Agent 已实现全部功能，但由于缺少 macOS 测试环境，尚未经过实机验证。如有问题欢迎 [提 issue](https://github.com/Monika-Dream/live-dashboard/issues)。

## 下载

预编译版本可从 [GitHub Releases](https://github.com/Monika-Dream/live-dashboard/releases) 下载 `live-dashboard-agent-macos.zip`。

## 这个分支包含什么

macOS Agent 是一个 Python 桌面程序，监控前台窗口并向 Live Dashboard 后端实时上报应用使用状态。启动后常驻菜单栏运行。
它会作为 `desktop_message` 设备接入服务端统一 `device_command` v1，显式声明完整桌面能力，只执行桌面文本提醒 `say`，并对冻结、解冻、震动、息屏和 LSP 监督策略返回不支持。

### 功能

| 功能 | 说明 |
|------|------|
| **前台应用检测** | 通过 AppleScript 获取前台应用名和窗口标题 |
| **音乐检测** | 查询 Spotify、Apple Music、QQ音乐、网易云音乐的播放状态和歌曲信息 |
| **电量上报** | 通过 psutil 获取 MacBook 电池电量和充电状态 |
| **AFK 检测** | IOKit `HIDIdleTime` 检测键鼠空闲，超过阈值（默认 5 分钟）后进入 AFK |
| **视频/音频免 AFK** | 有音频播放（pmset assertions）或前台全屏（AXFullScreen）时不进入 AFK |
| **系统托盘** | pystray 菜单栏图标，右键查看状态、打开设置、安全退出 |
| **AI 提醒** | 通过 WebSocket 或 `/api/messages` 接收 `device_command`，显示 macOS 通知并回传 receipt/result |

### 技术栈

- Python 3.10+ / PyInstaller 打包
- AppleScript (osascript) — 前台应用检测、全屏状态、音乐播放器查询
- pystray + Pillow — 菜单栏图标
- psutil — 电池信息
- ioreg / pmset — 空闲时间和音频状态检测
- websocket-client — 设备 WebSocket、AI 提醒和设备命令回执

### 文件结构

```
agents/macos/
├── agent.py              # 主程序
├── device_commands.py    # device_command v1 桌面子集执行
├── device_profile.py     # desktop_message 能力声明
├── realtime.py           # WebSocket、pending 命令补拉和回执
├── tests/                # 单元测试
├── config.example.json   # 配置模板
├── requirements.txt      # Python 依赖
└── README.md             # 详细使用说明
```

## 构建

```bash
pip install -r agents/macos/requirements.txt pyinstaller
cd agents/macos
python -m py_compile agent.py device_commands.py device_profile.py realtime.py
python -m unittest discover -s tests -v
pyinstaller --onefile --windowed --name live-dashboard-agent agent.py
# 产物: dist/live-dashboard-agent
```

`macOS Agent CI` 会在 `macos-source` 分支 push 后于 macOS runner 上执行测试和 PyInstaller 构建，并上传 `live-dashboard-agent-macos.zip` artifact。

## 权限要求

首次运行时需在「系统设置 → 隐私与安全性 → 辅助功能」中授权终端或 Python，否则无法获取窗口标题。

## 使用

详见 [`agents/macos/README.md`](agents/macos/README.md)。
