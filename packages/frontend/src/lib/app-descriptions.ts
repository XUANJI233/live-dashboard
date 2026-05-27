/**
 * Dramatized app description mapping.
 * Shows app name + playful activity description for privacy-friendly display.
 * Maps app_name (from backend app-names.json) to fun descriptions.
 */

const descriptions: Record<string, string> = {
  // Messaging
  Telegram: "在 TG 偷看频道喵~",
  QQ: "在 QQ 群里晒太阳喵~",
  TIM: "在 TIM 群里巡逻喵~",
  微信: "在微信翻聊记录喵~",
  WeChat: "在 WeChat 看喵友圈~",
  Discord: "在 Discord 听语音喵~",
  Line: "在 Line 看贴喵~",
  企业微信: "在企业微信回信喵~",
  钉钉: "在钉钉看公告喵~",
  Skype: "在 Skype 翻聊喵~",
  飞书: "在飞书看日程喵~",
  Lark: "在 Lark 看日程喵~",
  Slack: "在 Slack 偷看频道喵~",

  // AI assistants
  ChatGPT: "在和 ChatGPT 喵来喵去~",
  Claude: "在和 Claude 喵喵~",
  Gemini: "在和 Gemini 喵来喵去~",
  Copilot: "在和 Copilot 喵来喵去~",
  "Microsoft Copilot": "在和 Copilot 喵来喵去~",
  通义千问: "在和通义千问喵来喵去~",
  文心一言: "在对文心一言哈气!",
  Kimi: "在和 Kimi 喵来喵去~",
  豆包: "在和豆包喵来喵去~",
  DeepSeek: "在和 DeepSeek 喵来喵去~",
  Poe: "在和 Poe 喵来喵去~",
  Perplexity: "在和 Perplexity 喵来喵去~",
  "HuggingChat": "在和 HuggingChat 喵来喵去~",
  Ollama: "在和 Ollama 喵来喵去~",
  "LM Studio": "在和 LM Studio 喵来喵去~",

  // Browsers
  "Microsoft Edge": "在 Edge 浏览网页喵!",
  "Google Chrome": "在 Chrome 浏览网页喵!",
  Chrome: "在 Chrome 浏览网页喵!",
  Firefox: "在 Firefox 浏览网页喵!",
  Safari: "在 Safari 浏览网页喵~",
  Opera: "在 Opera 浏览网页喵~",
  Arc: "在 Arc 浏览网页喵~",
  Brave: "在 Brave 浏览网页喵!",
  Vivaldi: "在 Vivaldi 浏览网页喵!",
  "Opera GX": "在 Opera GX 浏览网页喵~",

  // Code editors
  "VS Code": "在 VS Code 编辑代码喵~",
  "Visual Studio Code": "在 VS Code 编辑代码喵~",
  "Visual Studio": "在 Visual Studio 写代码喵~",
  "IntelliJ IDEA": "在 IDEA 写代码喵~",
  PyCharm: "在 PyCharm 写代码喵~",
  WebStorm: "在 WebStorm 写代码喵~",
  GoLand: "在 GoLand 写代码喵~",
  "JetBrains Rider": "在 Rider 写代码喵~",
  DataGrip: "在 DataGrip 查询数据库喵~",
  "Android Studio": "在 Android Studio 写代码喵~",
  Cursor: "在 Cursor 编辑代码喵~",
  "Sublime Text": "在 Sublime 编辑文本喵~",
  "Google Antigravity": "在 Antigravity 使用 AI 辅助喵~",
  Windsurf: "在 Windsurf 编辑代码喵~",
  Zed: "在 Zed 编辑代码喵~",
  CLion: "在 CLion 写 C++喵~",
  RustRover: "在 RustRover 写 Rust喵~",
  "JetBrains Fleet": "在 Fleet 写代码喵~",
  HBuilderX: "在 HBuilderX 开发前端喵~",
  Vim: "在 Vim 编辑喵~",
  Neovim: "在 Neovim 编辑喵~",
  Emacs: "在 Emacs 编辑喵~",
  "Notepad++": "在 Notepad++ 编辑喵~",

  // Dev tools
  "Docker Desktop": "在 Docker 摆弄容器喵~",
  "GitHub Desktop": "在 GitHub Desktop 整理仓库喵~",
  Postman: "在 Postman 调试接口喵~",
  DBeaver: "在 DBeaver 查询数据库",
  Navicat: "在 Navicat 查询数据库",
  Insomnia: "在 Insomnia 调试接口",
  Wireshark: "在 Wireshark 抓包",
  Fiddler: "在 Fiddler 抓包",
  "Charles Proxy": "在 Charles 抓包喵~",
  GitKraken: "在 GitKraken 管理代码",
  "Sourcetree": "在 Sourcetree 管理仓库喵~",

  // Design tools
  Figma: "在 Figma 进行设计喵~",
  Sketch: "在 Sketch 进行设计喵~",
  Photoshop: "在 Photoshop 修图喵~",
  "Adobe Photoshop": "在 Photoshop 修图喵~",
  Illustrator: "在 Illustrator 绘制矢量图",
  "Adobe Illustrator": "在 Illustrator 画矢量喵~",
  "Premiere Pro": "在 Premiere 剪片喵~",
  "Adobe Premiere Pro": "在 Premiere 剪片喵~",
  "After Effects": "在 AE 做特效喵~",
  "Adobe After Effects": "在 AE 做特效喵~",
  Blender: "在 Blender 进行 3D 制作",
  "Cinema 4D": "在 C4D 搞 3D 喵~",
  GIMP: "在 GIMP 修图",
  Canva: "在 Canva 进行设计",
  "Adobe XD": "在 XD 做原型喵~",
  "DaVinci Resolve": "在 达芬奇 剪辑喵~",
  剪映: "在 剪映 剪辑视频",
  CapCut: "在 剪映 剪辑视频",
  Lightroom: "在 Lightroom 修图",
  "Adobe Lightroom": "在 Lightroom 调色喵~",
  InDesign: "在 InDesign 排版",
  "Adobe InDesign": "在 InDesign 排版喵~",
  "Affinity Photo": "在 Affinity 修图喵~",
  "Affinity Designer": "在 Affinity 设计喵~",
  Pixelmator: "在 Pixelmator 修图",
  "Paint.NET": "在 Paint.NET 涂鸦喵~",
  SAI: "在 SAI 绘画",
  "Clip Studio Paint": "在 CSP 画画喵~",
  MediBang: "在 MediBang 绘画",
  Krita: "在 Krita 绘画",

  // File managers
  文件资源管理器: "在浏览文件",
  "File Explorer": "在文件里翻找喵~",
  文件管理: "在文件里翻找喵~",
  Finder: "在文件里翻找喵~",
  "Total Commander": "在文件里翻找喵~",

  // Terminals
  "Windows Terminal": "在终端敲命令喵~",
  终端: "在终端敲命令喵~",
  Terminal: "在终端敲命令喵~",
  PowerShell: "在 PowerShell 玩命令喵~",
  命令提示符: "在命令提示符打字喵~",
  "Command Prompt": "在命令提示符打字喵~",
  iTerm2: "在 iTerm2 翻页喵~",
  Termux: "在 Termux 小玩意喵~",
  Alacritty: "在 Alacritty 敲敲喵~",
  Warp: "在 Warp 加速喵~",
  Kitty: "在 Kitty 打字喵~",

  // Video
  哔哩哔哩: "在 B 站观看视频喵!",
  bilibili: "在 B 站观看视频喵!",
  YouTube: "在 YouTube 观看视频喵!",
  Netflix: "在 Netflix 追剧喵!",
  爱奇艺: "在爱奇艺追剧喵!",
  优酷: "在优酷追剧喵!",
  腾讯视频: "在腾讯视频追剧喵!",
  VLC: "在 VLC 播放视频喵~",
  PotPlayer: "在 PotPlayer 播放视频喵~",
  mpv: "在 mpv 播放视频喵~",
  Twitch: "在 Twitch 观看直播喵~",
  "Disney+": "在 Disney+ 追剧喵!",
  芒果TV: "在 芒果TV 追剧喵~",
  斗鱼: "在 斗鱼 观看直播喵~",
  虎牙: "在 虎牙 观看直播喵~",
  "Prime Video": "在 Prime Video 追剧喵~",
  HBO: "在 HBO 追剧喵~",

  // Music
  Spotify: "在 Spotify 听歌喵~",
  网易云音乐: "在网易云听歌喵~",
  "QQ音乐": "在 QQ 音乐听歌喵~",
  酷狗音乐: "在酷狗听歌喵~",
  "Apple Music": "在 Apple Music 听歌喵~",
  foobar2000: "在 foobar2000 听歌喵~",
  "YouTube Music": "在 YouTube Music 听歌喵~",
  酷我音乐: "在酷我听歌喵~",
  "Amazon Music": "在 Amazon Music 听歌喵~",
  AIMP: "在 AIMP 听歌喵~",
  Audacity: "在 Audacity 编辑音频喵~",

  // Gaming
  Steam: "在 Steam 玩游戏喵!",
  "Epic Games": "在 Epic 玩耍喵~",
  "Genshin Impact": "在提瓦特探险喵~",
  原神: "在提瓦特探险喵~",
  "League of Legends": "在峡谷比拼喵~",
  英雄联盟: "在峡谷比拼喵~",
  "Honkai: Star Rail": "在星穹铁道冒险喵~",
  "崩坏：星穹铁道": "在星穹铁道冒险喵~",
  Minecraft: "在 Minecraft 挖洞喵~",
  "王者荣耀": "在峡谷奋战喵~",
  "和平精英": "在游戏里隐蔽喵~",
  VALORANT: "在 VALORANT 瞄准喵~",
  "Counter-Strike 2": "在 CS2 对战喵~",
  CSGO: "在 CSGO 对战喵~",
  Overwatch: "在守望先锋冲锋喵~",
  "Apex Legends": "在 Apex 探险喵~",
  "Elden Ring": "在交界地探险喵~",
  "Zelda": "在海拉鲁冒险喵~",
  Roblox: "在 Roblox 玩耍喵~",
  "GOG Galaxy": "在 GOG 翻游戏喵~",
  "Xbox": "在 Xbox 玩控制喵~",
  "EA App": "在 EA 平台玩耍喵~",
  "Ubisoft Connect": "在育碧找任务喵~",
  "Battle.net": "在暴雪平台组队喵~",
  "明日方舟": "在罗德岛指挥喵~",
  "Arknights": "在罗德岛指挥喵~",
  "绝区零": "在出击喵~",
  "鸣潮": "在海边冒险喵~",

  // Galgame / Visual Novels
  "いろとりどりのセカイ": "在看视觉小说剧情喵~",
  "五彩斑斓的世界": "在看视觉小说喵~",
  FAVORITE: "在攻略视觉小说喵~",
  "ものべの": "在沉浸剧情喵~",
  CLANNAD: "在看 CLANNAD 剧情喵~",
  "Fate/stay night": "在读 Fate 剧情喵~",
  "Summer Pockets": "在Summer Pockets 游玩喵~",
  "サマーポケッツ": "在看剧情喵~",
  "Doki Doki Literature Club": "在玩视觉小说喵~",
  "WHITE ALBUM 2": "在看剧情喵~",
  "千恋＊万花": "在攻略恋爱线喵~",
  "Making*Lovers": "在玩视觉小说喵~",
  "Sabbat of the Witch": "在看剧情喵~",
  "サノバウィッチ": "在玩视觉小说喵~",
  "Riddle Joker": "在看视觉小说喵~",
  "喫茶ステラと死神の蝶": "在看视觉小说喵~",
  Kirikiri: "在玩视觉小说",
  KiriKiri: "在玩视觉小说",
  BGI: "在玩视觉小说",
  SiglusEngine: "在玩视觉小说",
  Ethornell: "在玩视觉小说",
  CatSystem2: "在玩视觉小说",

  // Productivity
  Word: "在 Word 写文档喵~",
  "Microsoft Word": "在 Word 写文档喵~",
  Excel: "在 Excel 处理表格喵~",
  "Microsoft Excel": "在 Excel 处理表格喵~",
  PowerPoint: "在制作幻灯片喵~",
  "Microsoft PowerPoint": "在制作幻灯片喵~",
  OneNote: "在 OneNote 做笔记喵~",
  Notion: "在 Notion 做笔记喵~",
  Obsidian: "在 Obsidian 做笔记喵~",
  Typora: "在 Typora 编辑文档喵~",
  记事本: "在记事本编辑喵~",
  "WPS Office": "在 WPS 办公喵~",
  WPS: "在 WPS 办公喵~",
  "Google Docs": "在 Google 文档编辑喵~",
  "Google Sheets": "在 Google 表格处理喵~",
  "Google Slides": "在 Google 幻灯片制作喵~",
  Trello: "在 Trello 管理任务喵~",
  Todoist: "在 Todoist 管理待办喵~",
  "Logseq": "在 Logseq 做笔记喵~",
  印象笔记: "在印象笔记记事喵~",
  Evernote: "在印象笔记记事喵~",

  // Reading / E-book
  Kindle: "在 Kindle 阅读",
  微信读书: "在微信读书阅读",
  "多看阅读": "在多看阅读翻书喵~",
  "Apple Books": "在 Apple Books 看书喵~",
  Calibre: "在 Calibre 管理书库",

  // Social / Reading
  Twitter: "在刷推特喵!",
  X: "在 X 偷瞄喵~",
  微博: "在微博看热搜喵~",
  小红书: "在小红书寻宝喵~",
  抖音: "在抖音看短片喵!",
  TikTok: "在 TikTok 跳舞喵~",
  知乎: "在知乎偷学喵~",
  今日头条: "在头条逛新闻喵~",
  Reddit: "在 Reddit 探险喵~",
  GitHub: "在 GitHub 偷看代码喵~",
  酷安: "在酷安翻应用喵~",
  百度: "在百度找答案喵~",
  Instagram: "在 Instagram 看美图喵~",
  Facebook: "在 Facebook 看朋友动态喵~",
  Pinterest: "在 Pinterest 翻灵感喵~",
  Threads: "在 Threads 低声说喵~",
  快手: "在快手刷短片喵~",
  B站漫画: "在 B 站看漫画喵~",

  // Proxy tools
  "Mihomo Party": "在调代理小心喵~",
  Clash: "在调代理喵~",
  "Clash Verge": "在调网络喵~",
  v2rayN: "在调整代理设置",
  Shadowrocket: "在调整代理设置",
  Quantumult: "在调整代理设置",
  Surge: "在调整代理设置",
  NekoBox: "在调整代理设置",

  // Download / Transfer
  qBittorrent: "在下载内容喵~",
  "µTorrent": "在下载种子喵~",
  BitComet: "在下载内容喵~",
  迅雷: "在用迅雷下东西喵~",
  IDM: "在用 IDM 抓取喵~",
  "Internet Download Manager": "在用 IDM 抓取喵~",
  Motrix: "在下载东西喵~",
  "Free Download Manager": "在抓资源喵~",

  // Cloud storage
  "Google Drive": "在 Google Drive 同步喵~",
  OneDrive: "在 OneDrive 同步",
  百度网盘: "在百度网盘",
  阿里云盘: "在阿里云盘",
  Dropbox: "在 Dropbox 同步",

  // Remote desktop / Meeting
  "TeamViewer": "在 TeamViewer 远控喵~",
  "ToDesk": "在 ToDesk 远控喵~",
  向日葵: "在远程控制",
  腾讯会议: "在开会",
  Zoom: "在开会",
  "Microsoft Teams": "在 Teams 开会喵~",
  "Google Meet": "在 Google Meet 开会喵~",
  钉钉会议: "在开会",
  飞书会议: "在开会",

  // System
  任务管理器: "在查看任务管理器",
  "Task Manager": "在任务管理器看着喵~",
  系统设置: "在调整系统设置",
  设置: "在调整设置",
  Settings: "在调整设置",
  小米设置: "在调整手机设置",
  搜索: "在搜索内容",
  输入法: "在输入文字",
  画图: "在绘画",
  "UWP 应用": "在用 UWP 小程序喵~",
  "系统 Shell": "在系统界面摸索喵~",
  系统界面: "在系统界面调试喵~",
  "控制面板": "在调系统设置喵~",
  "Control Panel": "在调系统设置喵~",

  // Android specific
  android: "手机在线",

  // Shopping / Services
  支付宝: "在使用支付宝",
  淘宝: "在逛淘宝",
  京东: "在逛京东",
  拼多多: "在逛拼多多",
  唯品会: "在逛特卖平台",
  美团: "在点外卖",
  饿了么: "在点外卖",
  大众点评: "在查找美食",
  小米应用商店: "在浏览应用商店",
  闲鱼: "在闲鱼浏览二手",
  "Google Play": "在应用商店逛逛喵~",
  "App Store": "在应用商店逛逛喵~",

  // Travel
  铁路12306: "在订火车票",
  携程: "在订行程",
  百度地图: "在查看地图",
  高德地图: "在查看地图",
  "Google Maps": "在看地图喵~",
  滴滴出行: "在叫车",
  飞猪: "在订行程",
};

const DEFAULT_DESCRIPTION = "正在忙别的喵~";

// Pre-build lowercase index for O(1) lookups
const lowerIndex = new Map<string, string>();
for (const [key, value] of Object.entries(descriptions)) {
  lowerIndex.set(key.toLowerCase(), value);
}

// Music app names (lowercase) — used to avoid duplicate music info in descriptions
const _musicAppNames = new Set([
  "spotify", "网易云音乐", "qq音乐", "酷狗音乐", "apple music",
  "foobar2000", "youtube music", "酷我音乐", "amazon music", "aimp",
  "musicbee", "vlc", "potplayer", "windows media player",
]);

// ── Display title templates by app category ──
// When displayTitle is available, use a richer template with the title embedded.

type TitleTemplate = (displayTitle: string) => string;

const titleTemplates = new Map<string, TitleTemplate>();

function registerTemplate(names: string[], template: TitleTemplate) {
  for (const n of names) {
    titleTemplates.set(n.toLowerCase(), template);
  }
}

// Video apps
registerTemplate(
  ["YouTube"],
  (t) => `正在YouTube看「${t}」喵!`
);
registerTemplate(
  ["哔哩哔哩", "bilibili"],
  (t) => `正在B站看「${t}」喵!`
);
registerTemplate(
  ["Netflix"],
  (t) => `正在Netflix看「${t}」喵!`
);
registerTemplate(
  ["爱奇艺"],
  (t) => `正在爱奇艺看「${t}」喵!`
);
registerTemplate(
  ["优酷"],
  (t) => `正在优酷看「${t}」喵!`
);
registerTemplate(
  ["腾讯视频"],
  (t) => `正在腾讯视频看「${t}」喵!`
);
registerTemplate(
  ["VLC", "PotPlayer", "mpv"],
  (t) => `正在看「${t}」喵!`
);
// New video platforms
registerTemplate(
  ["Twitch"],
  (t) => `正在Twitch看「${t}」喵~`
);
registerTemplate(
  ["Disney+"],
  (t) => `正在Disney+看「${t}」喵!`
);
registerTemplate(
  ["芒果TV"],
  (t) => `正在芒果TV看「${t}」喵~`
);
registerTemplate(
  ["斗鱼"],
  (t) => `正在斗鱼看「${t}」喵~`
);
registerTemplate(
  ["虎牙"],
  (t) => `正在虎牙看「${t}」喵~`
);
registerTemplate(
  ["Prime Video"],
  (t) => `正在Prime Video看「${t}」喵~`
);
registerTemplate(
  ["HBO"],
  (t) => `正在HBO看「${t}」喵~`
);

// Music apps
registerTemplate(
  ["Spotify"],
  (t) => `正在Spotify听「${t}」喵!`
);
registerTemplate(
  ["网易云音乐"],
  (t) => `正在网易云听「${t}」喵!`
);
registerTemplate(
  ["QQ音乐"],
  (t) => `正在QQ音乐听「${t}」喵!`
);
registerTemplate(
  ["酷狗音乐"],
  (t) => `正在酷狗听「${t}」喵!`
);
registerTemplate(
  ["Apple Music"],
  (t) => `正在Apple Music听「${t}」喵!`
);
registerTemplate(
  ["foobar2000"],
  (t) => `正在听「${t}」喵!`
);
registerTemplate(
  ["YouTube Music"],
  (t) => `正在YouTube Music听「${t}」喵!`
);
registerTemplate(
  ["酷我音乐"],
  (t) => `正在酷我听「${t}」喵!`
);
registerTemplate(
  ["Amazon Music"],
  (t) => `正在Amazon Music听「${t}」喵!`
);
registerTemplate(
  ["AIMP"],
  (t) => `正在听「${t}」喵!`
);

// IDE / editors
registerTemplate(
  ["VS Code", "Visual Studio Code"],
  (t) => `正在用VS Code写「${t}」喵~`
);
registerTemplate(
  ["Cursor"],
  (t) => `正在用Cursor写「${t}」喵~`
);
registerTemplate(
  ["IntelliJ IDEA"],
  (t) => `正在用IDEA写「${t}」喵~`
);
registerTemplate(
  ["PyCharm", "WebStorm", "GoLand", "JetBrains Rider", "DataGrip", "Android Studio"],
  (t) => `正在写「${t}」喵!`
);
registerTemplate(
  ["Sublime Text"],
  (t) => `正在用Sublime写「${t}」喵!`
);
registerTemplate(
  ["Visual Studio"],
  (t) => `正在用VS写「${t}」喵!`
);
registerTemplate(
  ["Google Antigravity"],
  (t) => `正在用Antigravity写「${t}」喵!`
);
registerTemplate(
  ["Windsurf"],
  (t) => `正在用Windsurf写「${t}」喵!`
);
registerTemplate(
  ["Zed"],
  (t) => `正在用Zed写「${t}」喵!`
);
registerTemplate(
  ["CLion", "RustRover", "JetBrains Fleet", "HBuilderX"],
  (t) => `正在写「${t}」喵!`
);
registerTemplate(
  ["Vim", "Neovim"],
  (t) => `正在用Vim写「${t}」喵!`
);
registerTemplate(
  ["Emacs"],
  (t) => `正在用Emacs写「${t}」喵!`
);
registerTemplate(
  ["Notepad++"],
  (t) => `正在用Notepad++写「${t}」喵!`
);

// Dev tools
registerTemplate(
  ["Docker Desktop"],
  (t) => `正在用Docker搞「${t}」喵!`
);
registerTemplate(
  ["GitHub Desktop"],
  (t) => `正在GitHub上搞「${t}」喵!`
);
registerTemplate(
  ["Postman"],
  (t) => `正在用Postman调「${t}」喵!`
);
registerTemplate(
  ["DBeaver", "Navicat"],
  (t) => `正在查「${t}」数据库喵!`
);
registerTemplate(
  ["Insomnia"],
  (t) => `正在用Insomnia调「${t}」喵!`
);
registerTemplate(
  ["GitKraken"],
  (t) => `正在用GitKraken搞「${t}」喵!`
);
registerTemplate(
  ["Sourcetree"],
  (t) => `正在用Sourcetree搞「${t}」喵!`
);

// Gaming platforms — displayTitle IS the game title
registerTemplate(
  ["Steam"],
  (t) => {
    const tl = t.toLowerCase();
    if (tl === "steam" || tl === "") return "正在浏览 Steam 喵!";
    if (tl === "好友列表") return "正在与 Steam 好友聊天喵!";
    // Hash-like strings (screenshot viewer etc) or friend names — hide details
    if (/^[0-9a-f]{20,}/i.test(t)) return "正在浏览 Steam 喵!";
    // Check if it looks like a game name (contains letters/CJK, not just a short nickname)
    // Short titles without spaces/special chars are likely friend nicknames
    // Game titles typically have spaces, English words, or are longer
    if (t.length <= 20 && !/\s/.test(t) && !/[a-z]{3,}/i.test(t)) return "正在与 Steam 好友聊天喵!";
    return `正在Steam玩「${t}」喵!`;
  }
);
registerTemplate(
  ["Epic Games"],
  (t) => `正在Epic玩「${t}」喵!`
);
registerTemplate(
  ["GOG Galaxy"],
  (t) => `正在GOG玩「${t}」喵!`
);
registerTemplate(
  ["Xbox"],
  (t) => `正在Xbox玩「${t}」喵!`
);
registerTemplate(
  ["EA App"],
  (t) => `正在EA玩「${t}」喵!`
);
registerTemplate(
  ["Ubisoft Connect"],
  (t) => `正在育碧玩「${t}」喵!`
);
registerTemplate(
  ["Battle.net"],
  (t) => `正在暴雪玩「${t}」喵!`
);
// Galgame engines — show gal title
registerTemplate(
  [
    "Kirikiri", "KiriKiri", "BGI", "SiglusEngine", "Ethornell", "CatSystem2",
    "いろとりどりのセカイ", "五彩斑斓的世界", "FAVORITE", "ものべの",
    "CLANNAD", "Fate/stay night", "Summer Pockets", "サマーポケッツ",
    "Doki Doki Literature Club", "WHITE ALBUM 2", "千恋＊万花",
    "Making*Lovers", "Sabbat of the Witch", "サノバウィッチ",
    "Riddle Joker", "喫茶ステラと死神の蝶",
  ],
  (t) => `正在攻略「${t}」喵!`
);

// Productivity
registerTemplate(
  ["Word", "Microsoft Word"],
  (t) => `正在用Word写「${t}」喵!`
);
registerTemplate(
  ["Excel", "Microsoft Excel"],
  (t) => `正在用Excel看「${t}」喵!`
);
registerTemplate(
  ["PowerPoint", "Microsoft PowerPoint"],
  (t) => `正在做「${t}」PPT喵!`
);
registerTemplate(
  ["OneNote"],
  (t) => `正在OneNote写「${t}」喵!`
);
registerTemplate(
  ["Notion"],
  (t) => `正在Notion看「${t}」喵!`
);
registerTemplate(
  ["Obsidian"],
  (t) => `正在Obsidian写「${t}」喵!`
);
registerTemplate(
  ["Typora"],
  (t) => `正在Typora写「${t}」喵!`
);
registerTemplate(
  ["WPS Office", "WPS"],
  (t) => `正在用WPS写「${t}」喵!`
);
registerTemplate(
  ["Google Docs"],
  (t) => `正在Google文档写「${t}」喵!`
);
registerTemplate(
  ["Logseq"],
  (t) => `正在Logseq写「${t}」喵!`
);

// Design tools
registerTemplate(
  ["Figma"],
  (t) => `正在用Figma做「${t}」喵!`
);
registerTemplate(
  ["Photoshop", "Adobe Photoshop"],
  (t) => `正在用Photoshop修「${t}」喵!`
);
registerTemplate(
  ["Illustrator", "Adobe Illustrator"],
  (t) => `正在用Illustrator画「${t}」喵!`
);
registerTemplate(
  ["Premiere Pro", "Adobe Premiere Pro"],
  (t) => `正在用Premiere剪「${t}」喵!`
);
registerTemplate(
  ["After Effects", "Adobe After Effects"],
  (t) => `正在用AE做「${t}」喵!`
);
registerTemplate(
  ["Blender"],
  (t) => `正在用Blender搞「${t}」喵!`
);
registerTemplate(
  ["DaVinci Resolve"],
  (t) => `正在用达芬奇剪「${t}」喵!`
);
registerTemplate(
  ["剪映", "CapCut"],
  (t) => `正在用剪映剪「${t}」喵!`
);
registerTemplate(
  ["Lightroom", "Adobe Lightroom"],
  (t) => `正在用Lightroom修「${t}」喵!`
);
registerTemplate(
  ["SAI", "Clip Studio Paint", "MediBang", "Krita"],
  (t) => `正在画「${t}」喵!`
);

// Reading
registerTemplate(
  ["Kindle"],
  (t) => `正在Kindle看「${t}」喵!`
);
registerTemplate(
  ["微信读书"],
  (t) => `正在微信读书看「${t}」喵!`
);

// Browser — when display_title is available (video site page, generic page title)
registerTemplate(
  ["Google Chrome", "Chrome"],
  (t) => `正在用Chrome看「${t}」喵!`
);
registerTemplate(
  ["Microsoft Edge"],
  (t) => `正在用Edge看「${t}」喵!`
);
registerTemplate(
  ["Firefox"],
  (t) => `正在用Firefox看「${t}」喵!`
);
registerTemplate(
  ["Safari", "Opera", "Arc"],
  (t) => `正在看「${t}」喵!`
);
registerTemplate(
  ["Brave"],
  (t) => `正在用Brave看「${t}」喵!`
);
registerTemplate(
  ["Vivaldi"],
  (t) => `正在用Vivaldi看「${t}」喵!`
);

export function getAppDescription(appName: string, displayTitle?: string, music?: { title?: string; artist?: string; app?: string }): string {
  if (!appName) return DEFAULT_DESCRIPTION;

  const appLower = appName.toLowerCase();
  const cleanTitle = (displayTitle || "").trim();

  if (appLower === "idle") return "暂时离开了喵~";
  const isMusicAppForeground = _musicAppNames.has(appLower);

  // Base description (with or without display title)
  let base: string | undefined;

  // If we have a display_title, try to use a rich template
  // BUT skip template for music apps when music extra is present (♪ line handles song info)
  if (cleanTitle && !(isMusicAppForeground && music?.title)) {
    const template = titleTemplates.get(appLower);
    if (template) {
      base = template(cleanTitle);
    }
  }

  if (!base) {
    // Known app without template → use generic description
    const desc = lowerIndex.get(appLower);
    if (desc) {
      base = desc;
    }
  }

  if (!base) {
    // Unknown app with a display title → show it
    if (displayTitle) {
      base = `正在玩「${displayTitle}」喵!`;
    } else if (appName && appLower !== "unknown") {
      base = `正在用${appName}喵~`;
    } else {
      base = DEFAULT_DESCRIPTION;
    }
  }

  // Music info is shown via the ♪ line in CurrentStatus, so no need to embed it in description

  return base;
}

