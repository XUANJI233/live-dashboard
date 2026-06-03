/**
 * Dramatized app description mapping.
 * Shows app name + playful activity description for privacy-friendly display.
 * Maps app_name (from backend app-names.json) to fun descriptions.
 */

const descriptions: Record<string, string> = {
  // Messaging
  Telegram: "正在TG上冲浪喵~",
  QQ: "正在QQ上水群喵~",
  TIM: "正在TIM上水群喵~",
  微信: "正在微信上聊天喵~",
  WeChat: "正在微信上聊天喵~",
  Discord: "正在Discord灌水喵~",
  Line: "正在Line上聊天喵~",
  企业微信: "正在企业微信办公喵~",
  钉钉: "正在钉钉办公喵~",
  Skype: "正在Skype上聊天喵~",
  飞书: "正在飞书办公喵~",
  Lark: "正在飞书办公喵~",
  Slack: "正在Slack摸鱼喵~",

  // AI assistants
  ChatGPT: "正在和ChatGPT对话喵~",
  Claude: "正在和Claude对话喵~",
  Gemini: "正在和Gemini对话喵~",
  Copilot: "正在和Copilot对话喵~",
  "Microsoft Copilot": "正在和Copilot对话喵~",
  通义千问: "正在和通义千问对话喵~",
  文心一言: "正在和文心一言对话喵~",
  Kimi: "正在和Kimi对话喵~",
  豆包: "正在和豆包对话喵~",
  DeepSeek: "正在和DeepSeek对话喵~",
  Poe: "正在Poe上和AI对话喵~",
  Perplexity: "正在用Perplexity搜索喵~",
  "HuggingChat": "正在和HuggingChat对话喵~",
  Ollama: "正在本地跑AI模型喵~",
  "LM Studio": "正在本地跑AI模型喵~",

  // Browsers
  "Microsoft Edge": "正在用Edge网上冲浪喵~",
  "Google Chrome": "正在用Chrome网上冲浪喵~",
  Chrome: "正在用Chrome网上冲浪喵~",
  Firefox: "正在用Firefox网上冲浪喵~",
  Safari: "正在用Safari网上冲浪喵~",
  Opera: "正在用Opera网上冲浪喵~",
  Arc: "正在用Arc网上冲浪喵~",
  Brave: "正在用Brave网上冲浪喵~",
  Vivaldi: "正在用Vivaldi网上冲浪喵~",
  "Opera GX": "正在用Opera GX网上冲浪喵~",
  浏览器: "正在用浏览器网上冲浪喵~",
  小米浏览器: "正在用小米浏览器网上冲浪喵~",
  "Samsung Internet": "正在用Samsung Internet网上冲浪喵~",
  DuckDuckGo: "正在用DuckDuckGo网上冲浪喵~",
  Via: "正在用Via浏览喵~",
  "Kiwi Browser": "正在用Kiwi浏览喵~",
  Quark: "正在用夸克浏览喵~",
  "UC Browser": "正在用UC浏览喵~",
  "HeyTap Browser": "正在用浏览器网上冲浪喵~",
  "Vivo Browser": "正在用浏览器网上冲浪喵~",
  "Huawei Browser": "正在用浏览器网上冲浪喵~",

  // Code editors
  "VS Code": "正在用VS Code疯狂写bug喵~",
  "Visual Studio Code": "正在用VS Code疯狂写bug喵~",
  "Visual Studio": "正在用VS写代码喵~",
  "IntelliJ IDEA": "正在用IDEA写代码喵~",
  PyCharm: "正在用PyCharm写代码喵~",
  WebStorm: "正在用WebStorm写代码喵~",
  GoLand: "正在用GoLand写代码喵~",
  "JetBrains Rider": "正在用Rider写代码喵~",
  DataGrip: "正在用DataGrip查数据库喵~",
  "Android Studio": "正在用Android Studio写代码喵~",
  Cursor: "正在用Cursor疯狂写bug喵~",
  "Sublime Text": "正在用Sublime写代码喵~",
  "Google Antigravity": "正在用Antigravity让AI帮忙写代码喵~",
  Windsurf: "正在用Windsurf写代码喵~",
  Zed: "正在用Zed写代码喵~",
  CLion: "正在用CLion写C++喵~",
  RustRover: "正在用RustRover写Rust喵~",
  "JetBrains Fleet": "正在用Fleet写代码喵~",
  HBuilderX: "正在用HBuilderX写前端喵~",
  Vim: "正在用Vim写代码喵~",
  Neovim: "正在用Neovim写代码喵~",
  Emacs: "正在用Emacs写代码喵~",
  "Notepad++": "正在用Notepad++写代码喵~",

  // Dev tools
  "Docker Desktop": "正在用Docker搞容器喵~",
  "GitHub Desktop": "正在用GitHub Desktop管理代码喵~",
  Postman: "正在用Postman调接口喵~",
  DBeaver: "正在用DBeaver查数据库喵~",
  Navicat: "正在用Navicat查数据库喵~",
  Insomnia: "正在用Insomnia调接口喵~",
  Wireshark: "正在用Wireshark抓包喵~",
  Fiddler: "正在用Fiddler抓包喵~",
  "Charles Proxy": "正在用Charles抓包喵~",
  GitKraken: "正在用GitKraken管理代码喵~",
  "Sourcetree": "正在用Sourcetree管理代码喵~",

  // Design tools
  Figma: "正在用Figma做设计喵~",
  Sketch: "正在用Sketch做设计喵~",
  Photoshop: "正在用Photoshop修图喵~",
  "Adobe Photoshop": "正在用Photoshop修图喵~",
  Illustrator: "正在用Illustrator画矢量图喵~",
  "Adobe Illustrator": "正在用Illustrator画矢量图喵~",
  "Premiere Pro": "正在用Premiere剪视频喵~",
  "Adobe Premiere Pro": "正在用Premiere剪视频喵~",
  "After Effects": "正在用AE做特效喵~",
  "Adobe After Effects": "正在用AE做特效喵~",
  Blender: "正在用Blender搞3D喵~",
  "Cinema 4D": "正在用C4D搞3D喵~",
  GIMP: "正在用GIMP修图喵~",
  Canva: "正在用Canva做设计喵~",
  "Adobe XD": "正在用XD做原型喵~",
  "DaVinci Resolve": "正在用达芬奇剪视频喵~",
  剪映: "正在用剪映剪视频喵~",
  CapCut: "正在用剪映剪视频喵~",
  Lightroom: "正在用Lightroom修照片喵~",
  "Adobe Lightroom": "正在用Lightroom修照片喵~",
  InDesign: "正在用InDesign排版喵~",
  "Adobe InDesign": "正在用InDesign排版喵~",
  "Affinity Photo": "正在用Affinity修图喵~",
  "Affinity Designer": "正在用Affinity做设计喵~",
  Pixelmator: "正在用Pixelmator修图喵~",
  "Paint.NET": "正在用Paint.NET画图喵~",
  SAI: "正在用SAI画画喵~",
  "Clip Studio Paint": "正在用CSP画画喵~",
  MediBang: "正在用MediBang画画喵~",
  Krita: "正在用Krita画画喵~",

  // File managers
  文件资源管理器: "正在翻文件夹找东西喵~",
  "File Explorer": "正在翻文件夹找东西喵~",
  文件管理: "正在翻文件夹找东西喵~",
  Finder: "正在翻文件夹找东西喵~",
  "Total Commander": "正在翻文件夹找东西喵~",

  // Terminals
  "Windows Terminal": "正在用命令行敲命令喵~",
  终端: "正在用命令行敲命令喵~",
  Terminal: "正在用命令行敲命令喵~",
  PowerShell: "正在用命令行敲命令喵~",
  命令提示符: "正在用命令行敲命令喵~",
  "Command Prompt": "正在用命令行敲命令喵~",
  iTerm2: "正在用命令行敲命令喵~",
  Termux: "正在Termux里搞事情喵~",
  Alacritty: "正在用命令行敲命令喵~",
  Warp: "正在用Warp敲命令喵~",
  Kitty: "正在用命令行敲命令喵~",

  // Video
  哔哩哔哩: "正在B站划水摸鱼喵~",
  bilibili: "正在B站划水摸鱼喵~",
  YouTube: "正在YouTube看视频喵~",
  Netflix: "正在Netflix追剧喵~",
  爱奇艺: "正在爱奇艺追剧喵~",
  优酷: "正在优酷追剧喵~",
  腾讯视频: "正在腾讯视频追剧喵~",
  VLC: "正在用VLC看视频喵~",
  PotPlayer: "正在用PotPlayer看视频喵~",
  mpv: "正在用mpv看视频喵~",
  Twitch: "正在Twitch看直播喵~",
  "Disney+": "正在Disney+追剧喵~",
  芒果TV: "正在芒果TV追剧喵~",
  斗鱼: "正在斗鱼看直播喵~",
  虎牙: "正在虎牙看直播喵~",
  "Prime Video": "正在Prime Video追剧喵~",
  HBO: "正在HBO追剧喵~",

  // Music
  Spotify: "正在Spotify听歌喵~",
  网易云音乐: "正在网易云听歌喵~",
  "QQ音乐": "正在QQ音乐听歌喵~",
  酷狗音乐: "正在酷狗听歌喵~",
  "Apple Music": "正在Apple Music听歌喵~",
  foobar2000: "正在用foobar2000听歌喵~",
  "YouTube Music": "正在YouTube Music听歌喵~",
  酷我音乐: "正在酷我听歌喵~",
  "Amazon Music": "正在Amazon Music听歌喵~",
  AIMP: "正在用AIMP听歌喵~",
  Audacity: "正在用Audacity编辑音频喵~",

  // Gaming
  Steam: "正在Steam玩游戏喵~",
  "Epic Games": "正在Epic玩游戏喵~",
  "Genshin Impact": "正在提瓦特冒险喵~",
  原神: "正在提瓦特冒险喵~",
  "League of Legends": "正在峡谷激战喵~",
  英雄联盟: "正在峡谷激战喵~",
  "Honkai: Star Rail": "正在星穹铁道开拓喵~",
  "崩坏：星穹铁道": "正在星穹铁道开拓喵~",
  Minecraft: "正在Minecraft挖矿喵~",
  "王者荣耀": "正在王者峡谷激战喵~",
  "和平精英": "正在吃鸡喵~",
  VALORANT: "正在VALORANT对枪喵~",
  "Counter-Strike 2": "正在CS2对枪喵~",
  CSGO: "正在CSGO对枪喵~",
  Overwatch: "正在守望先锋战斗喵~",
  "Apex Legends": "正在Apex大逃杀喵~",
  "Elden Ring": "正在交界地冒险喵~",
  "Zelda": "正在海拉鲁冒险喵~",
  Roblox: "正在Roblox玩喵~",
  "GOG Galaxy": "正在GOG玩游戏喵~",
  "Xbox": "正在Xbox玩游戏喵~",
  "EA App": "正在EA玩游戏喵~",
  "Ubisoft Connect": "正在育碧玩游戏喵~",
  "Battle.net": "正在暴雪玩游戏喵~",
  "明日方舟": "正在罗德岛指挥作战喵~",
  "Arknights": "正在罗德岛指挥作战喵~",
  "绝区零": "正在绝区零战斗喵~",
  "鸣潮": "正在鸣潮冒险喵~",

  // Galgame / Visual Novels
  "いろとりどりのセカイ": "正在攻略gal喵~",
  "五彩斑斓的世界": "正在攻略gal喵~",
  FAVORITE: "正在攻略gal喵~",
  "ものべの": "正在攻略gal喵~",
  CLANNAD: "正在攻略gal喵~",
  "Fate/stay night": "正在攻略gal喵~",
  "Summer Pockets": "正在攻略gal喵~",
  "サマーポケッツ": "正在攻略gal喵~",
  "Doki Doki Literature Club": "正在攻略gal喵~",
  "WHITE ALBUM 2": "正在攻略gal喵~",
  "千恋＊万花": "正在攻略gal喵~",
  "Making*Lovers": "正在攻略gal喵~",
  "Sabbat of the Witch": "正在攻略gal喵~",
  "サノバウィッチ": "正在攻略gal喵~",
  "Riddle Joker": "正在攻略gal喵~",
  "喫茶ステラと死神の蝶": "正在攻略gal喵~",
  Kirikiri: "正在攻略gal喵~",
  KiriKiri: "正在攻略gal喵~",
  BGI: "正在攻略gal喵~",
  SiglusEngine: "正在攻略gal喵~",
  Ethornell: "正在攻略gal喵~",
  CatSystem2: "正在攻略gal喵~",

  // Productivity
  Word: "正在用Word写文档喵~",
  "Microsoft Word": "正在用Word写文档喵~",
  Excel: "正在用Excel算数据喵~",
  "Microsoft Excel": "正在用Excel算数据喵~",
  PowerPoint: "正在做PPT喵~",
  "Microsoft PowerPoint": "正在做PPT喵~",
  OneNote: "正在用OneNote记笔记喵~",
  Notion: "正在用Notion记笔记喵~",
  Obsidian: "正在用Obsidian记笔记喵~",
  Typora: "正在用Typora记笔记喵~",
  记事本: "正在用记事本写东西喵~",
  "WPS Office": "正在用WPS办公喵~",
  WPS: "正在用WPS办公喵~",
  "Google Docs": "正在用Google文档写东西喵~",
  "Google Sheets": "正在用Google表格算数据喵~",
  "Google Slides": "正在用Google幻灯片做PPT喵~",
  Trello: "正在用Trello管理任务喵~",
  Todoist: "正在用Todoist管理待办喵~",
  "Logseq": "正在用Logseq记笔记喵~",
  印象笔记: "正在用印象笔记记东西喵~",
  Evernote: "正在用印象笔记记东西喵~",

  // Reading / E-book
  Kindle: "正在Kindle看书喵~",
  微信读书: "正在微信读书看书喵~",
  "多看阅读": "正在多看阅读看书喵~",
  "Apple Books": "正在看书喵~",
  Calibre: "正在用Calibre看书喵~",

  // Social / Reading
  Twitter: "正在刷推特喵~",
  X: "正在刷推特喵~",
  微博: "正在微博吃瓜喵~",
  小红书: "正在逛小红书喵~",
  抖音: "正在刷短视频喵~",
  TikTok: "正在刷短视频喵~",
  知乎: "正在知乎涨知识喵~",
  今日头条: "正在刷今日头条喵~",
  Reddit: "正在Reddit冲浪喵~",
  GitHub: "正在GitHub摸鱼喵~",
  酷安: "正在酷安逛帖子喵~",
  百度: "正在百度搜东西喵~",
  Instagram: "正在刷Instagram喵~",
  Facebook: "正在逛Facebook喵~",
  Pinterest: "正在Pinterest找灵感喵~",
  Threads: "正在刷Threads喵~",
  快手: "正在刷快手喵~",
  B站漫画: "正在B站看漫画喵~",

  // Proxy tools
  "Mihomo Party": "正在调代理设置喵~",
  Clash: "正在调代理设置喵~",
  "Clash Verge": "正在调代理设置喵~",
  v2rayN: "正在调代理设置喵~",
  Shadowrocket: "正在调代理设置喵~",
  Quantumult: "正在调代理设置喵~",
  Surge: "正在调代理设置喵~",
  NekoBox: "正在调代理设置喵~",

  // Download / Transfer
  qBittorrent: "正在下载东西喵~",
  "µTorrent": "正在下载东西喵~",
  BitComet: "正在下载东西喵~",
  迅雷: "正在用迅雷下载喵~",
  IDM: "正在用IDM下载喵~",
  "Internet Download Manager": "正在用IDM下载喵~",
  Motrix: "正在下载东西喵~",
  "Free Download Manager": "正在下载东西喵~",

  // Cloud storage
  "Google Drive": "正在用Google云端硬盘喵~",
  OneDrive: "正在用OneDrive同步文件喵~",
  百度网盘: "正在用百度网盘喵~",
  阿里云盘: "正在用阿里云盘喵~",
  Dropbox: "正在用Dropbox同步文件喵~",

  // Remote desktop / Meeting
  "TeamViewer": "正在远程控制喵~",
  "ToDesk": "正在远程控制喵~",
  向日葵: "正在远程控制喵~",
  腾讯会议: "正在开会喵~",
  Zoom: "正在开会喵~",
  "Microsoft Teams": "正在用Teams开会喵~",
  "Google Meet": "正在开会喵~",
  钉钉会议: "正在开会喵~",
  飞书会议: "正在开会喵~",

  // System
  任务管理器: "正在看任务管理器喵~",
  "Task Manager": "正在看任务管理器喵~",
  系统设置: "正在调系统设置喵~",
  设置: "正在调设置喵~",
  Settings: "正在调设置喵~",
  小米设置: "正在调手机设置喵~",
  搜索: "正在搜索东西喵~",
  输入法: "正在打字喵~",
  画图: "正在画画喵~",
  "UWP 应用": "正在用UWP应用喵~",
  "系统 Shell": "在系统界面喵~",
  系统界面: "在系统界面喵~",
  "控制面板": "正在调系统设置喵~",
  "Control Panel": "正在调系统设置喵~",

  // Android specific
  桌面: "在主屏幕发呆中喵~",
  相机: "正在拍照喵~",
  相册: "正在翻相册喵~",
  计算器: "正在算数喵~",
  日历: "正在看日历喵~",
  时钟: "正在看时间喵~",
  手机管家: "正在清理手机喵~",
  天气: "正在看天气喵~",
  录音机: "正在录音喵~",
  扫一扫: "正在扫码喵~",
  便签: "正在记便签喵~",

  // Shopping / Services
  支付宝: "正在用支付宝喵~",
  淘宝: "正在逛淘宝剁手喵~",
  京东: "正在逛京东剁手喵~",
  拼多多: "正在拼多多砍一刀喵~",
  Amazon: "正在Amazon逛逛喵~",
  亚马逊: "正在亚马逊逛逛喵~",
  "Amazon Shopping": "正在Amazon逛逛喵~",
  唯品会: "正在唯品会逛特卖喵~",
  美团: "正在美团点外卖喵~",
  饿了么: "正在饿了么点外卖喵~",
  大众点评: "正在大众点评找好吃的喵~",
  小米应用商店: "正在逛应用商店喵~",
  闲鱼: "正在逛闲鱼淘二手喵~",
  "Google Play": "正在逛应用商店喵~",
  "App Store": "正在逛应用商店喵~",

  // Travel
  铁路12306: "正在12306买火车票喵~",
  携程: "正在携程订行程喵~",
  百度地图: "正在看地图喵~",
  高德地图: "正在看地图喵~",
  "Google Maps": "正在看地图喵~",
  滴滴出行: "正在叫车喵~",
  飞猪: "正在飞猪订行程喵~",
};

// Special states
descriptions["sleeping"] = "(-.-)zzZ";
descriptions["idle"] = "暂时离开喵~";

type ExpandedDescriptionGroup = {
  names: string[];
  templates: Array<(name: string) => string>;
};

const ADULT_APP_NAMES = [
  "FANZA Games", "DMM Game Player", "DLsite Nest", "DLsite Play", "Nutaku",
  "Johren", "JAST USA", "MangaGamer", "Denpasoft", "FAKKU",
  "Iwara", "E-Hentai", "nhentai", "Hitomi Downloader", "Hydrus Network",
  "Honey Select 2", "Koikatsu Party", "Custom Order Maid 3D2", "VR Kanojo", "House Party",
  "Mirror 2: Project X", "Mirror", "NEKOPARA Vol. 1", "NEKOPARA Vol. 2", "NEKOPARA Vol. 3",
  "NEKOPARA Vol. 4", "Sakura Dungeon", "Sakura Swim Club", "Sakura Angels", "HuniePop",
  "HuniePop 2", "Subverse", "Seed of the Dead", "Wild Life", "AI Shoujo",
  "Room Girl", "Action Taimanin", "Taimanin Asagi", "Rance X", "Evenicle",
];

const expandedDescriptionGroups: ExpandedDescriptionGroup[] = [
  {
    names: [
      "Signal", "WhatsApp", "WhatsApp Business", "Messenger", "Facebook Messenger",
      "Google Chat", "Google Messages", "Messages", "KakaoTalk", "Zalo",
      "Viber", "Threema", "Element", "Matrix", "Session",
      "SimpleX Chat", "Beeper", "ICQ", "IRCCloud", "mIRC",
      "HexChat", "Revolt", "Guilded", "Mumble", "TeamSpeak",
      "Zoom Team Chat", "Mattermost", "Rocket.Chat", "Zulip", "Twist",
      "Chanty", "Flock", "Misskey", "Mastodon", "Bluesky",
    ],
    templates: [
      (n) => `正在${n}里接住消息喵~`,
      (n) => `正在${n}上热烈聊天喵~`,
      (n) => `正在${n}里整理对话线索喵~`,
      (n) => `正在${n}守着新消息喵~`,
    ],
  },
  {
    names: [
      "Microsoft 365 Copilot", "GitHub Copilot Chat", "Cursor Agent", "Codeium",
      "Cody", "Tabnine", "Continue", "Phind", "You.com",
      "YouChat", "Monica", "Sider", "Merlin", "Pi",
      "Character.AI", "Jan", "Open WebUI", "AnythingLLM", "GPT4All",
      "Msty", "OpenRouter", "Groq", "Mistral Le Chat", "Le Chat",
      "Qwen Chat", "讯飞星火", "智谱清言", "MiniMax", "元宝",
      "Grok", "NotebookLM", "Elicit", "Consensus", "Scite",
      "SciSpace", "WolframAlpha", "Wolfram Alpha",
    ],
    templates: [
      (n) => `正在和${n}推敲答案喵~`,
      (n) => `正在让${n}帮忙拆问题喵~`,
      (n) => `正在${n}里召唤灵感喵~`,
      (n) => `正在用${n}把想法磨亮喵~`,
    ],
  },
  {
    names: [
      "Tor Browser", "Waterfox", "LibreWolf", "Pale Moon", "Floorp",
      "Zen Browser", "Maxthon", "Yandex Browser", "Cốc Cốc", "Aloha Browser",
      "Puffin Browser", "Phoenix Browser", "Mi Browser", "QQ浏览器", "夸克浏览器",
      "搜狗浏览器", "360安全浏览器", "360极速浏览器", "百度浏览器", "猎豹浏览器",
      "QQ Browser", "Sogou Explorer", "Chromium", "Ungoogled Chromium", "Thorium",
      "SRWare Iron", "Avast Secure Browser", "AVG Secure Browser", "Firefox Developer Edition", "Firefox Nightly",
    ],
    templates: [
      (n) => `正在用${n}穿梭网页喵~`,
      (n) => `正在${n}里翻找答案喵~`,
      (n) => `正在用${n}打开新世界喵~`,
      (n) => `正在${n}上捕捉网页线索喵~`,
    ],
  },
  {
    names: [
      "PhpStorm", "RubyMine", "AppCode", "Aqua", "Xcode",
      "Arduino IDE", "Eclipse", "NetBeans", "Qt Creator", "MonoDevelop",
      "Code::Blocks", "Dev-C++", "BlueJ", "RStudio", "RStudio Desktop",
      "Spyder", "JupyterLab", "Jupyter Notebook", "Anaconda Navigator", "Google Colab",
      "Replit", "CodeSandbox", "StackBlitz", "Glitch", "Trae",
      "Aptana Studio", "Komodo IDE", "TextMate", "BBEdit", "Nova",
      "Coda", "CotEditor", "Geany", "Kate", "KDevelop",
      "VSCodium", "Lite XL", "Helix", "Lapce", "Micro",
      "GNU nano", "CodePen", "Processing", "Racket", "DrRacket",
      "MATLAB", "Octave", "LabVIEW", "Stata", "SAS",
    ],
    templates: [
      (n) => `正在用${n}打磨代码喵~`,
      (n) => `正在${n}里追踪一个小问题喵~`,
      (n) => `正在用${n}把逻辑串起来喵~`,
      (n) => `正在${n}里认真写工程喵~`,
    ],
  },
  {
    names: [
      "Fork", "Tower", "TortoiseGit", "TortoiseSVN", "SmartGit",
      "Git Extensions", "Git Cola", "Lazygit", "Magit", "GitAhead",
      "GitLab", "Bitbucket", "Gitea", "Jenkins", "TeamCity",
      "Bamboo", "CircleCI", "Travis CI", "Drone", "Buildkite",
      "Azure DevOps", "Google Cloud Console", "AWS Console", "AWS Toolkit", "Azure Portal",
      "Firebase Console", "Supabase", "Vercel", "Netlify", "Render",
      "Heroku", "Railway", "Fly.io", "Cloudflare", "Cloudflare Dashboard",
      "Kubernetes Dashboard", "Lens", "K9s", "Rancher Desktop", "Minikube",
      "Podman Desktop", "Portainer", "TablePlus", "Sequel Ace", "Sequel Pro",
      "HeidiSQL", "pgAdmin", "phpMyAdmin", "RedisInsight", "MongoDB Compass",
      "Studio 3T", "Robo 3T", "Beekeeper Studio", "DataSpell", "Oracle SQL Developer",
      "MySQL Workbench", "DB Browser for SQLite", "SQLiteStudio", "HTTPie", "Bruno",
      "Hoppscotch", "Apifox", "Swagger UI", "Stoplight Studio", "RapidAPI",
      "Proxyman", "mitmproxy", "Burp Suite", "OWASP ZAP", "Nmap",
      "OpenVPN", "WireGuard", "Tailscale", "ZeroTier", "Ngrok",
      "LocalTunnel", "PageKite", "WinSCP", "PuTTY", "MobaXterm",
      "Xshell", "FinalShell", "Termius", "SecureCRT", "Royal TS",
    ],
    templates: [
      (n) => `正在用${n}处理开发现场喵~`,
      (n) => `正在${n}里检查工程脉搏喵~`,
      (n) => `正在用${n}排查技术细节喵~`,
      (n) => `正在${n}上让服务乖乖运转喵~`,
    ],
  },
  {
    names: [
      "Framer", "Penpot", "Lunacy", "CorelDRAW", "Corel Painter",
      "Inkscape", "Gravit Designer", "Vectr", "Vecteezy Editor", "Miro",
      "FigJam", "Whimsical", "Balsamiq", "Axure RP", "ProtoPie",
      "Principle", "Origami Studio", "Zeplin", "Abstract", "Marvel",
      "Moqups", "Mockplus", "uizard", "Rive", "LottieFiles",
      "Spine", "Aseprite", "Piskel", "Pixel Studio", "Procreate",
      "Concepts", "Infinite Painter", "ibisPaint", "Autodesk SketchBook", "ArtRage",
      "FireAlpaca", "PaintTool SAI", "Nomad Sculpt", "ZBrush", "Maya",
      "3ds Max", "Houdini", "Substance 3D Painter", "Substance 3D Designer", "Marvelous Designer",
      "Marmoset Toolbag", "Unreal Engine", "Unity", "Godot", "MagicaVoxel",
    ],
    templates: [
      (n) => `正在用${n}雕琢视觉喵~`,
      (n) => `正在${n}里摆弄创意零件喵~`,
      (n) => `正在用${n}把画面调顺眼喵~`,
      (n) => `正在${n}里做漂亮东西喵~`,
    ],
  },
  {
    names: [
      "Final Cut Pro", "iMovie", "Kdenlive", "Shotcut", "OpenShot",
      "Olive", "Avid Media Composer", "Vegas Pro", "HitFilm",
      "Filmora", "Camtasia", "ScreenFlow", "OBS Studio", "Streamlabs",
      "XSplit Broadcaster", "vMix", "Lightworks", "HandBrake", "Format Factory",
      "Shutter Encoder", "Media Encoder", "Adobe Media Encoder", "Topaz Video AI", "Topaz Photo AI",
      "Topaz Gigapixel AI", "Topaz DeNoise AI", "Topaz Sharpen AI", "LumaFusion", "VN Video Editor",
      "Alight Motion", "KineMaster", "InShot", "Canva Video", "Motion",
      "Compressor", "MediaInfo", "MKVToolNix", "LosslessCut", "VirtualDub",
      "Aegisub", "Subtitle Edit", "Subler", "IINA", "QuickTime Player",
      "Windows Media Player", "KMPlayer", "GOM Player", "MX Player", "nPlayer",
      "Infuse", "Plex", "Jellyfin", "Emby", "Kodi",
    ],
    templates: [
      (n) => `正在用${n}处理影像喵~`,
      (n) => `正在${n}里剪出节奏喵~`,
      (n) => `正在用${n}整理画面和声音喵~`,
      (n) => `正在${n}上看视频宇宙喵~`,
    ],
  },
  {
    names: [
      "TIDAL", "Deezer", "Pandora", "SoundCloud", "Bandcamp",
      "Qobuz", "iHeartRadio", "TuneIn Radio", "Pocket Casts", "Overcast",
      "Castbox", "Podcast Addict", "AntennaPod", "Apple Podcasts", "Google Podcasts",
      "MusicBee", "Dopamine", "Winamp", "Clementine", "Strawberry Music Player",
      "Rhythmbox", "Amarok", "Vox", "Djay", "Serato DJ",
      "VirtualDJ", "Traktor Pro", "FL Studio", "Ableton Live", "Logic Pro",
      "GarageBand", "Cubase", "Reaper", "Pro Tools", "Studio One",
      "Bitwig Studio", "Reason", "Cakewalk", "LMMS", "MuseScore",
      "Sibelius", "Dorico", "Finale", "Capo", "Guitar Pro",
    ],
    templates: [
      (n) => `正在用${n}听点好东西喵~`,
      (n) => `正在${n}里调动耳朵喵~`,
      (n) => `正在用${n}编排声音喵~`,
      (n) => `正在${n}里追一段旋律喵~`,
    ],
  },
  {
    names: [
      "Notion Calendar", "Google Calendar", "Microsoft To Do", "Apple Notes", "Google Keep",
      "Bear", "Craft", "Roam Research", "RemNote", "Heptabase",
      "Capacities", "Tana", "Anytype", "Workflowy", "Dynalist",
      "Simplenote", "Joplin", "Standard Notes", "UpNote", "Ulysses",
      "Scrivener", "iA Writer", "Bear Notes", "Zettlr", "MarkText",
      "Dropbox Paper", "Quip", "Airtable", "Smartsheet",
      "Asana", "ClickUp", "Monday.com", "Linear", "Jira",
      "Confluence", "Basecamp", "Height", "Shortcut", "YouTrack",
      "OmniFocus", "Things", "TickTick", "滴答清单", "Teambition",
      "ProcessOn", "MindNode", "XMind", "FreeMind", "MindManager",
      "Milanote", "Readwise", "Readwise Reader", "Raindrop.io", "Pocket",
      "Instapaper", "DEVONthink", "Zotero", "Mendeley", "EndNote",
      "Citavi", "MarginNote", "LiquidText", "GoodNotes", "Notability",
      "PDF Expert", "Adobe Acrobat", "Foxit PDF Reader", "SumatraPDF", "Okular",
      "ONLYOFFICE", "LibreOffice", "OpenOffice", "Numbers", "Keynote",
      "Pages", "Polaris Office", "Zoho Writer", "Zoho Sheet", "Zoho Show",
    ],
    templates: [
      (n) => `正在用${n}整理脑内桌面喵~`,
      (n) => `正在${n}里推进待办喵~`,
      (n) => `正在用${n}把资料排队喵~`,
      (n) => `正在${n}上认真办公喵~`,
    ],
  },
  {
    names: [
      "Audible", "Kobo", "Google Play Books", "Moon+ Reader", "FBReader",
      "ReadEra", "Lithium", "KOReader", "BookFusion", "Libby",
      "OverDrive", "Goodreads", "起点读书", "QQ阅读", "七猫免费小说",
      "番茄小说", "掌阅", "书旗小说", "喜马拉雅", "得到",
      "知乎盐选", "Medium", "Substack", "Inoreader", "Feedly",
      "NetNewsWire", "Reeder", "NewsBlur", "Fluent Reader", "Tiny Tiny RSS",
    ],
    templates: [
      (n) => `正在${n}里读点东西喵~`,
      (n) => `正在用${n}补充精神食粮喵~`,
      (n) => `正在${n}上翻页前进喵~`,
      (n) => `正在用${n}追一篇长文喵~`,
    ],
  },
  {
    names: [
      "Snapchat", "LinkedIn", "Tumblr", "Quora", "Hacker News",
      "Lobsters", "Product Hunt", "Dribbble", "Behance", "ArtStation",
      "Pixiv", "Pixiv Sketch", "Niconico", "ニコニコ動画", "AcFun",
      "豆瓣", "即刻", "少数派", "什么值得买", "TapTap",
      "NGA玩家社区", "贴吧", "百度贴吧", "天涯社区", "雪球",
      "东方财富", "同花顺", "TradingView", "虎扑", "懂车帝",
      "汽车之家", "OpenSea", "Farcaster", "Warpcast", "Truth Social",
      "VK", "OK.ru", "Weibo International", "LOFTER", "花瓣",
      "500px", "Flickr", "VSCO", "Letterboxd", "IMDb",
      "Rotten Tomatoes", "Douyin", "YouTube Studio", "Creator Studio", "哔哩哔哩直播姬",
    ],
    templates: [
      (n) => `正在${n}上刷新世界喵~`,
      (n) => `正在逛${n}收集新鲜事喵~`,
      (n) => `正在${n}里围观热闹喵~`,
      (n) => `正在用${n}看看大家在聊什么喵~`,
    ],
  },
  {
    names: [
      "Avast", "AVG AntiVirus", "Avira", "Bitdefender", "ESET",
      "Kaspersky", "Malwarebytes", "Norton 360", "McAfee", "Windows Security",
      "Microsoft Defender", "火绒安全", "360安全卫士", "腾讯电脑管家", "鲁大师",
      "CCleaner", "BleachBit", "Geek Uninstaller", "Revo Uninstaller", "IObit Uninstaller",
      "Everything", "Listary", "Flow Launcher", "PowerToys", "Wox",
      "Launchy", "Alfred", "Raycast", "Karabiner-Elements", "AutoHotkey",
      "AutoIt", "Ditto", "ClipboardFusion", "CopyQ", "Snipaste",
      "ShareX", "Greenshot", "Lightshot", "Flameshot", "PicPick",
      "FastStone Capture", "CleanMyMac X", "DaisyDisk", "TreeSize", "WinDirStat",
      "SpaceSniffer", "CrystalDiskInfo", "CrystalDiskMark", "HWiNFO", "CPU-Z",
      "GPU-Z", "MSI Afterburner", "RivaTuner Statistics Server", "Process Explorer", "Process Monitor",
      "Autoruns", "WizTree", "7-Zip", "WinRAR", "Bandizip",
      "PeaZip", "Keka", "The Unarchiver", "Rufus", "balenaEtcher",
      "Ventoy", "VirtualBox", "VMware Workstation", "VMware Fusion", "Parallels Desktop",
      "UTM", "QEMU", "Hyper-V", "Sandboxie", "Sandboxie Plus",
    ],
    templates: [
      (n) => `正在用${n}维护设备喵~`,
      (n) => `正在${n}里检查系统状态喵~`,
      (n) => `正在用${n}清点电脑角落喵~`,
      (n) => `正在${n}上处理系统小事务喵~`,
    ],
  },
  {
    names: [
      "MEGA", "Box", "pCloud", "Sync.com", "Tresorit",
      "iCloud Drive", "坚果云", "夸克网盘", "115网盘", "天翼云盘",
      "和彩云", "Resilio Sync", "Syncthing", "Nextcloud", "Seafile",
      "Rclone", "Cyberduck", "Transmit", "FileZilla", "Mountain Duck",
      "AnyDesk", "RustDesk", "Chrome Remote Desktop", "Parsec", "Moonlight",
      "Sunshine", "NoMachine", "Remote Desktop", "Microsoft Remote Desktop", "VNC Viewer",
      "RealVNC", "TightVNC", "Splashtop", "AirDroid", "KDE Connect",
      "LocalSend", "Nearby Share", "Quick Share", "Portal", "Snapdrop",
      "Warpinator", "Barrier", "Synergy", "Mouse without Borders", "Deskreen",
      "RescueTime", "Toggl Track", "Clockify", "Harvest", "Timely",
    ],
    templates: [
      (n) => `正在用${n}搬运数据喵~`,
      (n) => `正在${n}里同步重要文件喵~`,
      (n) => `正在用${n}连到远方设备喵~`,
      (n) => `正在${n}上安排跨设备协作喵~`,
    ],
  },
  {
    names: [
      "Google Play Store", "APKPure", "Aurora Store", "F-Droid", "TapTap国际版",
      "酷安应用集", "华为应用市场", "OPPO软件商店", "vivo应用商店", "三星应用商店",
      "小米商城", "米家", "京喜", "苏宁易购", "国美",
      "1688", "Temu", "SHEIN", "Shopee", "Lazada",
      "eBay", "Etsy", "AliExpress", "Wish", "Wayfair",
      "Instacart", "DoorDash", "Uber Eats", "Grubhub", "Deliveroo",
      "Foodpanda", "KFC", "McDonald's", "Starbucks", "瑞幸咖啡",
      "库迪咖啡", "盒马", "叮咚买菜", "美团买菜", "多点",
      "携程旅行", "去哪儿旅行", "同程旅行", "马蜂窝", "途牛旅游",
      "Booking.com", "Airbnb", "Agoda", "Tripadvisor", "Expedia",
      "Skyscanner", "Google Flights", "航旅纵横", "飞常准", "Grab",
      "Uber", "Lyft", "Bolt", "滴滴青桔", "哈啰",
      "支付宝商家版", "PayPal", "Venmo", "Cash App", "Wise",
      "Revolut", "Monzo", "招商银行", "中国银行", "建设银行",
      "工商银行", "农业银行", "交通银行", "云闪付", "Apple Wallet",
      "Google Wallet", "Samsung Wallet", "Robinhood", "Coinbase", "Binance",
      "Kraken", "OKX", "Bybit", "MetaMask", "Phantom",
      "Trust Wallet", "Ledger Live", "Exodus", "Steam Mobile", "Nintendo Switch Online",
    ],
    templates: [
      (n) => `正在${n}里处理生活补给喵~`,
      (n) => `正在用${n}安排钱包和行程喵~`,
      (n) => `正在逛${n}寻找划算选择喵~`,
      (n) => `正在${n}上把日常事务办妥喵~`,
    ],
  },
  {
    names: [
      "Google Classroom", "Moodle", "Canvas Student", "Blackboard", "Coursera",
      "edX", "Udemy", "Khan Academy", "Duolingo", "Memrise",
      "Anki", "Quizlet", "Brilliant", "Codecademy", "freeCodeCamp",
      "LeetCode", "HackerRank", "Codewars", "AtCoder", "Codeforces",
      "Kaggle", "Overleaf", "TeXstudio", "TeXworks", "LyX",
      "GeoGebra", "Desmos", "Graphing Calculator", "SPSS", "JASP",
      "Jamovi", "GraphPad Prism", "OriginPro", "GraphPad", "ChemDraw",
      "Chem3D", "Avogadro", "PyMOL", "UCSF Chimera", "QGIS",
      "ArcGIS Pro", "AutoCAD", "Fusion 360", "SolidWorks", "FreeCAD",
      "KiCad", "EasyEDA", "Proteus", "LTspice", "Multisim",
    ],
    templates: [
      (n) => `正在用${n}学习新知识喵~`,
      (n) => `正在${n}里和题目较劲喵~`,
      (n) => `正在用${n}做研究小动作喵~`,
      (n) => `正在${n}上把知识点串起来喵~`,
    ],
  },
  {
    names: [
      "Among Us", "Fortnite", "PUBG", "PUBG: BATTLEGROUNDS", "Destiny 2",
      "Dota 2", "Team Fortress 2", "Warframe", "Path of Exile", "Path of Exile 2",
      "World of Warcraft", "Hearthstone", "Diablo IV", "Diablo III", "StarCraft II",
      "Heroes of the Storm", "Call of Duty", "Call of Duty: Warzone", "Rainbow Six Siege", "The Finals",
      "Escape from Tarkov", "Helldivers 2", "Palworld", "Monster Hunter: World", "Monster Hunter Wilds",
      "Monster Hunter Rise", "Cyberpunk 2077", "The Witcher 3", "Baldur's Gate 3", "Baldurs Gate 3",
      "Final Fantasy XIV", "Final Fantasy VII Rebirth", "Final Fantasy XV", "Persona 5 Royal", "Persona 3 Reload",
      "Metaphor: ReFantazio", "Like a Dragon", "Yakuza 0", "Stardew Valley", "Terraria",
      "Factorio", "RimWorld", "Oxygen Not Included", "Don't Starve Together", "Hades",
      "Hades II", "Dead Cells", "Hollow Knight", "Celeste", "Cuphead",
      "Slay the Spire", "Balatro", "Vampire Survivors", "Risk of Rain 2", "No Man's Sky",
      "Subnautica", "Satisfactory", "Cities: Skylines", "Cities: Skylines II", "The Sims 4",
      "Civilization VI", "Civilization VII", "Age of Empires IV", "Crusader Kings III", "Europa Universalis IV",
      "Stellaris", "Total War: WARHAMMER III", "Football Manager", "EA SPORTS FC", "NBA 2K",
      "Rocket League", "Forza Horizon 5", "Gran Turismo 7", "F1 24", "Microsoft Flight Simulator",
      "Sea of Thieves", "Red Dead Redemption 2", "Grand Theft Auto V", "GTA V", "Lethal Company",
      "Phasmophobia", "Content Warning", "Project Zomboid", "DayZ", "ARK: Survival Ascended",
      "ARK: Survival Evolved", "Rust", "Valheim", "Enshrouded", "V Rising",
      "The Elder Scrolls V: Skyrim", "Fallout 4", "Fallout 76", "Starfield", "DOOM Eternal",
      "Resident Evil 4", "Resident Evil Village", "Silent Hill 2", "Alan Wake 2", "Control",
      "Death Stranding", "Sekiro", "Dark Souls III", "Bloodborne", "Armored Core VI",
      "Black Myth: Wukong", "黑神话：悟空", "永劫无间", "NARAKA: BLADEPOINT", "逆水寒",
      "剑网3", "梦幻西游", "阴阳师", "第五人格", "Identity V",
      "碧蓝航线", "Azur Lane", "少女前线", "Girls' Frontline", "崩坏3",
      "Honkai Impact 3rd", "蔚蓝档案", "Blue Archive", "NIKKE", "Goddess of Victory: NIKKE",
      "Fate/Grand Order", "FGO", "明日之后", "光遇", "Sky: Children of the Light",
      "Pokemon GO", "Pokémon GO", "Pokémon TCG Live", "Yu-Gi-Oh! Master Duel", "雀魂",
      "Mahjong Soul", "osu!", "Beat Saber", "VRChat", "Rec Room",
    ],
    templates: [
      (n) => `正在玩${n}推进冒险喵~`,
      (n) => `正在${n}里认真操作喵~`,
      (n) => `正在${n}的战场上忙起来喵~`,
      (n) => `正在${n}里享受游戏时间喵~`,
    ],
  },
  {
    names: [
      "Ren'Py", "吉里吉里Z", "ONScripter", "NScripter", "Live2D Viewer",
      "Live2D Cubism", "TyranoBuilder", "SteamVR", "Oculus", "Meta Quest",
      "PlayStation App", "PS Remote Play", "Chiaki", "Ryujinx", "Yuzu",
      "Dolphin Emulator", "PCSX2", "PPSSPP", "RPCS3", "Citra",
      "DuckStation", "RetroArch", "MAME", "OpenEmu", "mGBA",
      "Delta Emulator", "MelonDS", "DeSmuME", "Snes9x", "ScummVM",
    ],
    templates: [
      (n) => `正在用${n}打开游戏收藏喵~`,
      (n) => `正在${n}里调试游戏体验喵~`,
      (n) => `正在用${n}进入互动故事喵~`,
      (n) => `正在${n}里怀旧一下喵~`,
    ],
  },
  // Adult / NSFW-capable apps; descriptions stay non-graphic because they are shown in UI.
  {
    names: ADULT_APP_NAMES,
    templates: [
      (n) => `正在${n}里浏览成人向内容喵~`,
      (n) => `正在用${n}管理成人向收藏喵~`,
      (n) => `正在玩${n}的成人向剧情喵~`,
      (n) => `正在${n}上低调探索内容库喵~`,
    ],
  },
];

for (const group of expandedDescriptionGroups) {
  for (const [index, name] of group.names.entries()) {
    if (!descriptions[name]) {
      descriptions[name] = group.templates[index % group.templates.length](name);
    }
  }
}

const personalizedDescriptions: Record<string, string> = {
  Telegram: "正在Telegram里追频道和小窗消息喵~",
  QQ: "正在QQ里把群聊消息捞上岸喵~",
  TIM: "正在TIM里用办公皮肤水群喵~",
  微信: "正在微信里处理人间小事喵~",
  WeChat: "正在微信里处理人间小事喵~",
  Discord: "正在Discord里听频道热闹起来喵~",
  Line: "正在Line里收表情和消息喵~",
  企业微信: "正在企业微信里推进工作流喵~",
  钉钉: "正在钉钉里和待办打卡周旋喵~",
  飞书: "正在飞书里翻文档和消息喵~",
  Lark: "正在Lark里翻文档和消息喵~",
  Slack: "正在Slack里穿梭频道和线程喵~",

  ChatGPT: "正在和ChatGPT把想法聊成形喵~",
  Claude: "正在和Claude慢慢拆复杂问题喵~",
  Gemini: "正在Gemini里找多模态灵感喵~",
  Copilot: "正在让Copilot贴着上下文补一手喵~",
  "Microsoft Copilot": "正在让Copilot贴着上下文补一手喵~",
  通义千问: "正在通义千问里问点正经又不正经的喵~",
  文心一言: "正在文心一言里打磨中文答案喵~",
  Kimi: "正在Kimi里塞长文档求总结喵~",
  豆包: "正在豆包里把问题揉开喵~",
  DeepSeek: "正在DeepSeek里深挖推理链喵~",
  Poe: "正在Poe里切换AI选手喵~",
  Perplexity: "正在Perplexity里带引用找答案喵~",
  Ollama: "正在Ollama里本地烹煮模型喵~",
  "LM Studio": "正在LM Studio里给本地模型开小灶喵~",

  "Microsoft Edge": "正在Edge里开着侧栏冲浪喵~",
  "Google Chrome": "正在Chrome里管理标签页宇宙喵~",
  Chrome: "正在Chrome里管理标签页宇宙喵~",
  Safari: "正在Safari里安静翻网页喵~",
  Opera: "正在Opera里逛带点戏剧感的网页喵~",
  Arc: "正在Arc里把网页收进空间喵~",
  "Opera GX": "正在Opera GX里用玩家皮肤冲浪喵~",
  浏览器: "正在浏览器里打开一扇新窗口喵~",
  小米浏览器: "正在小米浏览器里刷手机网页喵~",
  "Samsung Internet": "正在Samsung Internet里稳稳浏览喵~",
  DuckDuckGo: "正在DuckDuckGo里低调搜索喵~",
  Quark: "正在夸克里轻装找答案喵~",
  "UC Browser": "正在UC里翻移动网页喵~",

  "VS Code": "正在VS Code里把灵感编译成现实喵~",
  "Visual Studio Code": "正在VS Code里把灵感编译成现实喵~",
  "Visual Studio": "正在Visual Studio里调一份大型工程喵~",
  "IntelliJ IDEA": "正在IDEA里和Java/Kotlin项目较劲喵~",
  PyCharm: "正在PyCharm里让Python跑顺喵~",
  WebStorm: "正在WebStorm里梳理前端风暴喵~",
  GoLand: "正在GoLand里追一只并发小问题喵~",
  "JetBrains Rider": "正在Rider里驾驭.NET工程喵~",
  DataGrip: "正在DataGrip里审问数据库喵~",
  "Android Studio": "正在Android Studio里喂Gradle转圈喵~",
  Cursor: "正在Cursor里和AI结对写代码喵~",
  Windsurf: "正在Windsurf里顺着代码气流前进喵~",
  Zed: "正在Zed里用高速编辑器写代码喵~",
  CLion: "正在CLion里啃C/C++工程喵~",
  RustRover: "正在RustRover里安抚借用检查器喵~",
  Vim: "正在Vim里用模式编辑飞行喵~",
  Neovim: "正在Neovim里把终端变成工坊喵~",
  Emacs: "正在Emacs里打开另一个宇宙喵~",

  "Docker Desktop": "正在Docker里把服务装进小盒子喵~",
  "GitHub Desktop": "正在GitHub Desktop里整理分支和提交喵~",
  Postman: "正在Postman里敲接口的门喵~",
  DBeaver: "正在DBeaver里翻数据库河床喵~",
  Navicat: "正在Navicat里点开数据库抽屉喵~",
  Insomnia: "正在Insomnia里试一口API请求喵~",
  Wireshark: "正在Wireshark里捕捉网络脉搏喵~",
  Fiddler: "正在Fiddler里拦路查看HTTP喵~",
  "Charles Proxy": "正在Charles里观察请求往返喵~",
  GitKraken: "正在GitKraken里看分支海图喵~",
  Sourcetree: "正在Sourcetree里整理提交树喵~",

  Figma: "正在Figma里推像素和组件喵~",
  Sketch: "正在Sketch里修一份设计稿喵~",
  Photoshop: "正在Photoshop里给图片做美容喵~",
  "Adobe Photoshop": "正在Photoshop里给图片做美容喵~",
  Illustrator: "正在Illustrator里拉矢量曲线喵~",
  "Adobe Illustrator": "正在Illustrator里拉矢量曲线喵~",
  "Premiere Pro": "正在Premiere里剪出时间线节奏喵~",
  "Adobe Premiere Pro": "正在Premiere里剪出时间线节奏喵~",
  "After Effects": "正在AE里让画面动起来喵~",
  "Adobe After Effects": "正在AE里让画面动起来喵~",
  Blender: "正在Blender里打磨三维小世界喵~",
  Canva: "正在Canva里快速拼一张好看的喵~",
  剪映: "正在剪映里给视频卡点喵~",
  CapCut: "正在剪映里给视频卡点喵~",
  Lightroom: "正在Lightroom里调照片的光喵~",
  "Clip Studio Paint": "正在CSP里认真勾线喵~",
  Krita: "正在Krita里开源画画喵~",

  哔哩哔哩: "正在B站看弹幕从屏幕上飘过喵~",
  bilibili: "正在B站看弹幕从屏幕上飘过喵~",
  YouTube: "正在YouTube里顺着推荐看下去喵~",
  Netflix: "正在Netflix里进入追剧状态喵~",
  爱奇艺: "正在爱奇艺里追国产剧喵~",
  腾讯视频: "正在腾讯视频里看会员片单喵~",
  VLC: "正在VLC里播放本地片源喵~",
  PotPlayer: "正在PotPlayer里细调播放器喵~",
  Twitch: "正在Twitch里围观直播现场喵~",
  斗鱼: "正在斗鱼里看直播间热闹喵~",
  虎牙: "正在虎牙里守着主播操作喵~",

  Spotify: "正在Spotify里让歌单接管心情喵~",
  网易云音乐: "正在网易云里听歌看评论喵~",
  "QQ音乐": "正在QQ音乐里点开收藏歌单喵~",
  酷狗音乐: "正在酷狗里找那首熟悉的旋律喵~",
  "Apple Music": "正在Apple Music里听无损小宇宙喵~",
  "YouTube Music": "正在YouTube Music里听MV旁边的歌喵~",
  Audacity: "正在Audacity里剪一段声音喵~",

  Steam: "正在Steam里打开游戏库选择困难喵~",
  "Epic Games": "正在Epic里领取或启动游戏喵~",
  "Genshin Impact": "正在提瓦特清体力和跑地图喵~",
  原神: "正在提瓦特清体力和跑地图喵~",
  "League of Legends": "正在峡谷里补刀看小地图喵~",
  英雄联盟: "正在峡谷里补刀看小地图喵~",
  "Honkai: Star Rail": "正在星穹列车上开拓喵~",
  "崩坏：星穹铁道": "正在星穹列车上开拓喵~",
  Minecraft: "正在Minecraft里把方块变成基地喵~",
  王者荣耀: "正在王者峡谷里推塔喵~",
  和平精英: "正在和平精英里找圈和物资喵~",
  VALORANT: "正在VALORANT里架枪听脚步喵~",
  "Counter-Strike 2": "正在CS2里丢道具对枪喵~",
  "Apex Legends": "正在Apex里滑铲进圈喵~",
  "Elden Ring": "正在交界地受苦也探索喵~",
  Roblox: "正在Roblox里跳进玩家造的世界喵~",
  明日方舟: "正在罗德岛摆干员喵~",
  绝区零: "正在新艾利都接委托喵~",
  鸣潮: "正在鸣潮里听声骸回响喵~",

  Word: "正在Word里和段落格式较量喵~",
  "Microsoft Word": "正在Word里和段落格式较量喵~",
  Excel: "正在Excel里让表格自己说话喵~",
  "Microsoft Excel": "正在Excel里让表格自己说话喵~",
  PowerPoint: "正在PowerPoint里排演一页重点喵~",
  "Microsoft PowerPoint": "正在PowerPoint里排演一页重点喵~",
  OneNote: "正在OneNote里把灵感按页收好喵~",
  Notion: "正在Notion里搭一座个人工作台喵~",
  Obsidian: "正在Obsidian里织知识链接喵~",
  Typora: "正在Typora里沉浸写Markdown喵~",
  WPS: "正在WPS里处理国产办公三件套喵~",
  "WPS Office": "正在WPS里处理国产办公三件套喵~",
  Trello: "正在Trello里拖动任务卡片喵~",
  Todoist: "正在Todoist里清点今日行动喵~",
  Logseq: "正在Logseq里折叠大纲和双链喵~",
  Evernote: "正在印象笔记里翻旧资料喵~",
  印象笔记: "正在印象笔记里翻旧资料喵~",

  Twitter: "正在X上刷时间线喵~",
  X: "正在X上刷时间线喵~",
  微博: "正在微博里围观热搜喵~",
  小红书: "正在小红书里收藏生活灵感喵~",
  抖音: "正在抖音里被短视频吸住喵~",
  TikTok: "正在TikTok里刷到停不下来喵~",
  知乎: "正在知乎里看长回答喵~",
  Reddit: "正在Reddit里潜水看讨论喵~",
  GitHub: "正在GitHub里翻仓库和issue喵~",
  Instagram: "正在Instagram里刷照片和Reels喵~",
  Pinterest: "正在Pinterest里钉住灵感喵~",

  Clash: "正在Clash里切换代理规则喵~",
  "Clash Verge": "正在Clash Verge里调节点喵~",
  "Mihomo Party": "正在Mihomo Party里开代理派对喵~",
  v2rayN: "正在v2rayN里测试延迟喵~",
  Surge: "正在Surge里看网络策略喵~",
  Shadowrocket: "正在Shadowrocket里拨动小火箭喵~",
  Quantumult: "正在Quantumult里精修分流规则喵~",
  NekoBox: "正在NekoBox里整理代理节点喵~",
  qBittorrent: "正在qBittorrent里排下载队列喵~",
  迅雷: "正在迅雷里加速下载喵~",
  OneDrive: "正在OneDrive里同步文件喵~",
  百度网盘: "正在百度网盘里等待传输完成喵~",
  阿里云盘: "正在阿里云盘里整理云端文件喵~",
  TeamViewer: "正在TeamViewer里远程救场喵~",
  ToDesk: "正在ToDesk里远程接屏幕喵~",
  向日葵: "正在向日葵里远程控制喵~",
  腾讯会议: "正在腾讯会议里听会看共享屏喵~",
  Zoom: "正在Zoom里开一场云会议喵~",
  "Microsoft Teams": "正在Teams里开会和找文件喵~",

  支付宝: "正在支付宝里处理生活账单喵~",
  淘宝: "正在淘宝里比较购物车喵~",
  京东: "正在京东里看物流和自营价喵~",
  拼多多: "正在拼多多里研究这刀还能不能砍喵~",
  美团: "正在美团里寻找下一顿喵~",
  饿了么: "正在饿了么里召唤外卖喵~",
  大众点评: "正在大众点评里找好吃的喵~",
  闲鱼: "正在闲鱼里淘二手宝贝喵~",
  铁路12306: "正在12306里和余票赛跑喵~",
  携程: "正在携程里安排出行喵~",
  百度地图: "正在百度地图里确认路线喵~",
  高德地图: "正在高德地图里规划怎么走喵~",
  "Google Maps": "正在Google Maps里看世界坐标喵~",
  滴滴出行: "正在滴滴里等司机接单喵~",

  "Windows Terminal": "正在Windows Terminal里开多标签命令台喵~",
  终端: "正在终端里敲下一条指令喵~",
  Terminal: "正在Terminal里和系统对话喵~",
  PowerShell: "正在PowerShell里施展管道魔法喵~",
  命令提示符: "正在命令提示符里走经典路线喵~",
  "Command Prompt": "正在Command Prompt里执行老派命令喵~",
  iTerm2: "正在iTerm2里开漂亮终端喵~",
  Alacritty: "正在Alacritty里高速敲命令喵~",
  Kitty: "正在Kitty里用GPU加速终端喵~",
  Termux: "正在Termux里把手机变成小Linux喵~",

  "いろとりどりのセカイ": "正在五彩世界里推进视觉小说喵~",
  "五彩斑斓的世界": "正在五彩斑斓的世界里读剧情喵~",
  FAVORITE: "正在FAVORITE作品里翻故事线喵~",
  "ものべの": "正在ものべの里慢慢读日常喵~",
  CLANNAD: "正在CLANNAD里走进光玉故事喵~",
  "Fate/stay night": "正在Fate/stay night里选择命运分支喵~",
  "Summer Pockets": "正在Summer Pockets里吹海岛夏风喵~",
  "サマーポケッツ": "正在サマーポケッツ里吹海岛夏风喵~",
  "Doki Doki Literature Club": "正在DDLC里体验文学部异常喵~",
  "WHITE ALBUM 2": "正在WHITE ALBUM 2里听冬日旋律喵~",
  "千恋＊万花": "正在千恋万花里看和风恋爱喵~",
  "Making*Lovers": "正在Making*Lovers里推进恋爱日常喵~",
  "Sabbat of the Witch": "正在魔女的夜宴里读剧情喵~",
  "サノバウィッチ": "正在サノバウィッチ里读剧情喵~",
  "Riddle Joker": "正在Riddle Joker里拆超能力谜题喵~",
  "喫茶ステラと死神の蝶": "正在星光咖啡馆里邂逅死神蝶喵~",
  Kirikiri: "正在Kirikiri引擎里打开视觉小说喵~",
  BGI: "正在BGI引擎里播放视觉小说喵~",
  SiglusEngine: "正在Siglus引擎里读Key味故事喵~",
  Ethornell: "正在Ethornell引擎里读剧情喵~",
  CatSystem2: "正在CatSystem2里运行视觉小说喵~",

  Signal: "正在Signal里发加密小纸条喵~",
  WhatsApp: "正在WhatsApp里跨时区聊天喵~",
  "WhatsApp Business": "正在WhatsApp Business里认真接待客户喵~",
  Messenger: "正在Messenger里接住朋友的碎碎念喵~",
  KakaoTalk: "正在KakaoTalk里看可爱贴纸飞来飞去喵~",
  Zalo: "正在Zalo里处理越南风味消息喵~",
  Element: "正在Element里穿梭Matrix房间喵~",
  Mumble: "正在Mumble里低延迟连麦喵~",
  TeamSpeak: "正在TeamSpeak里排战术语音喵~",
  Mattermost: "正在Mattermost里把团队频道理顺喵~",
  "Rocket.Chat": "正在Rocket.Chat里发射工作消息喵~",
  Zulip: "正在Zulip里按主题拆聊天线喵~",
  Mastodon: "正在Mastodon联邦时间线散步喵~",
  Bluesky: "正在Bluesky上刷蓝天动态喵~",

  "GitHub Copilot Chat": "正在和Copilot一起对着代码小声密谋喵~",
  Codeium: "正在让Codeium补全下一步灵感喵~",
  Cody: "正在问Cody这段代码到底想干嘛喵~",
  Tabnine: "正在让Tabnine猜下一行代码喵~",
  Continue: "正在Continue里把上下文塞给AI喵~",
  Phind: "正在Phind里追问技术答案喵~",
  "Character.AI": "正在Character.AI里和角色聊天入戏喵~",
  Jan: "正在Jan里本地召唤AI脑袋喵~",
  "Open WebUI": "正在Open WebUI里调教本地模型喵~",
  AnythingLLM: "正在AnythingLLM里投喂资料库喵~",
  GPT4All: "正在GPT4All里离线问AI喵~",
  NotebookLM: "正在NotebookLM里让笔记自己开口喵~",
  Elicit: "正在Elicit里捞论文线索喵~",
  Consensus: "正在Consensus里找学术共识喵~",
  Scite: "正在Scite里检查论文有没有被支持喵~",
  SciSpace: "正在SciSpace里拆论文硬骨头喵~",
  WolframAlpha: "正在WolframAlpha里算点硬核答案喵~",
  "Wolfram Alpha": "正在Wolfram Alpha里把问题算明白喵~",

  "Tor Browser": "正在Tor Browser里走洋葱小路喵~",
  LibreWolf: "正在LibreWolf里清爽隐私冲浪喵~",
  Waterfox: "正在Waterfox里逛复古火狐宇宙喵~",
  "Firefox Developer Edition": "正在Firefox Dev版里盯网页骨架喵~",
  "Firefox Nightly": "正在Firefox Nightly里试明天的浏览器喵~",
  "Yandex Browser": "正在Yandex Browser里打开俄式入口喵~",
  "QQ浏览器": "正在QQ浏览器里搜一搜喵~",
  "夸克浏览器": "正在夸克浏览器里轻装搜索喵~",
  "360安全浏览器": "正在360安全浏览器里安全冲浪喵~",
  "Firefox": "正在Firefox里开着标签页森林喵~",
  Brave: "正在Brave里挡广告攒清净喵~",
  Vivaldi: "正在Vivaldi里把标签页排成仪表盘喵~",

  Xcode: "正在Xcode里给苹果生态织代码喵~",
  PhpStorm: "正在PhpStorm里和PHP项目过招喵~",
  RubyMine: "正在RubyMine里打磨Ruby宝石喵~",
  Aqua: "正在Aqua里认真测接口和页面喵~",
  "Arduino IDE": "正在Arduino IDE里点亮小板子喵~",
  Eclipse: "正在Eclipse里翻老派工程喵~",
  NetBeans: "正在NetBeans里搭Java积木喵~",
  "Qt Creator": "正在Qt Creator里拼跨平台界面喵~",
  RStudio: "正在RStudio里和数据框较劲喵~",
  Spyder: "正在Spyder里科学计算喵~",
  JupyterLab: "正在JupyterLab里一格一格跑实验喵~",
  "Jupyter Notebook": "正在Jupyter Notebook里边算边记喵~",
  "Google Colab": "正在Colab里借云端GPU喵~",
  Replit: "正在Replit里开云端小工坊喵~",
  CodeSandbox: "正在CodeSandbox里搭前端沙盒喵~",
  StackBlitz: "正在StackBlitz里闪电开项目喵~",
  VSCodium: "正在VSCodium里写无遥测代码喵~",
  Helix: "正在Helix里用选择优先的姿势写代码喵~",
  MATLAB: "正在MATLAB里让矩阵排队喵~",
  LabVIEW: "正在LabVIEW里连图形化电路喵~",

  Fork: "正在Fork里把Git分支梳成小辫子喵~",
  Tower: "正在Tower里优雅整理提交记录喵~",
  TortoiseGit: "正在TortoiseGit里右键管理版本喵~",
  Lazygit: "正在Lazygit里飞快挑commit喵~",
  GitLab: "正在GitLab里看流水线转圈喵~",
  Bitbucket: "正在Bitbucket里照看仓库喵~",
  Jenkins: "正在Jenkins里盯构建小球变绿喵~",
  TeamCity: "正在TeamCity里巡检CI列车喵~",
  CircleCI: "正在CircleCI里等工作流跑完喵~",
  "Azure DevOps": "正在Azure DevOps里搬看板和流水线喵~",
  "AWS Console": "正在AWS Console里照看云上机器喵~",
  "Azure Portal": "正在Azure Portal里调云资源喵~",
  "Firebase Console": "正在Firebase里看应用火苗喵~",
  Supabase: "正在Supabase里给数据库开后门喵~",
  Vercel: "正在Vercel里等部署飞上云喵~",
  Netlify: "正在Netlify里发布静态魔法喵~",
  Render: "正在Render里照看服务呼吸喵~",
  "Fly.io": "正在Fly.io里让应用贴地飞行喵~",
  Cloudflare: "正在Cloudflare里给网站套盾喵~",
  Lens: "正在Lens里俯瞰Kubernetes集群喵~",
  K9s: "正在K9s里巡逻Pod喵~",
  Portainer: "正在Portainer里整理容器甲板喵~",
  TablePlus: "正在TablePlus里翻数据库抽屉喵~",
  pgAdmin: "正在pgAdmin里照看Postgres喵~",
  RedisInsight: "正在RedisInsight里看缓存小钥匙喵~",
  "MongoDB Compass": "正在MongoDB Compass里导航文档森林喵~",
  "MySQL Workbench": "正在MySQL Workbench里拧SQL螺丝喵~",
  Bruno: "正在Bruno里把API请求排整齐喵~",
  Hoppscotch: "正在Hoppscotch里轻快试接口喵~",
  Apifox: "正在Apifox里一边写文档一边调接口喵~",
  "Burp Suite": "正在Burp Suite里拦截请求做安全检查喵~",
  "OWASP ZAP": "正在ZAP里给网页做安全体检喵~",
  Nmap: "正在Nmap里敲门看看端口在不在家喵~",
  Tailscale: "正在Tailscale里把设备串成私有网喵~",
  WireGuard: "正在WireGuard里拉起一条安静隧道喵~",
  Ngrok: "正在Ngrok里把本地服务露个小窗口喵~",
  WinSCP: "正在WinSCP里搬远程文件喵~",
  PuTTY: "正在PuTTY里敲进远程终端喵~",
  MobaXterm: "正在MobaXterm里开一桌远程工具喵~",
  Termius: "正在Termius里优雅连SSH喵~",

  Framer: "正在Framer里把交互动起来喵~",
  Penpot: "正在Penpot里做开源设计稿喵~",
  Lunacy: "正在Lunacy里处理设计切片喵~",
  CorelDRAW: "正在CorelDRAW里拉贝塞尔曲线喵~",
  Inkscape: "正在Inkscape里画自由矢量喵~",
  Miro: "正在Miro白板上贴满想法喵~",
  FigJam: "正在FigJam里开脑暴便利贴喵~",
  Whimsical: "正在Whimsical里画流程小地图喵~",
  Balsamiq: "正在Balsamiq里涂低保真草图喵~",
  "Axure RP": "正在Axure里搭交互原型喵~",
  ProtoPie: "正在ProtoPie里调高级交互动效喵~",
  Rive: "正在Rive里让矢量角色动起来喵~",
  LottieFiles: "正在LottieFiles里挑小动画喵~",
  Aseprite: "正在Aseprite里点像素小砖块喵~",
  Procreate: "正在Procreate里挥Apple Pencil喵~",
  "ibisPaint": "正在ibisPaint里画移动端大作喵~",
  "Autodesk SketchBook": "正在SketchBook里随手起稿喵~",
  ZBrush: "正在ZBrush里捏数字泥巴喵~",
  Maya: "正在Maya里给模型搭骨架喵~",
  Houdini: "正在Houdini里煮程序化特效喵~",
  "Substance 3D Painter": "正在Substance Painter里给模型刷材质喵~",
  "Unreal Engine": "正在Unreal里点亮实时世界喵~",
  Unity: "正在Unity里调游戏物体喵~",
  Godot: "正在Godot里用节点搭游戏喵~",

  "Final Cut Pro": "正在Final Cut Pro里快刀剪片喵~",
  iMovie: "正在iMovie里把回忆剪成片喵~",
  Kdenlive: "正在Kdenlive里开源剪时间线喵~",
  Shotcut: "正在Shotcut里修剪视频段落喵~",
  "Avid Media Composer": "正在Avid里剪专业时间线喵~",
  "Vegas Pro": "正在Vegas Pro里切镜头踩节拍喵~",
  Filmora: "正在Filmora里给视频加点轻巧包装喵~",
  Camtasia: "正在Camtasia里录屏做教程喵~",
  "OBS Studio": "正在OBS里搭直播导播台喵~",
  Streamlabs: "正在Streamlabs里准备直播场景喵~",
  HandBrake: "正在HandBrake里压制视频喵~",
  MKVToolNix: "正在MKVToolNix里封装轨道喵~",
  LosslessCut: "正在LosslessCut里无损咔嚓一刀喵~",
  Aegisub: "正在Aegisub里给字幕对轴喵~",
  IINA: "正在IINA里优雅看本地视频喵~",
  Plex: "正在Plex里巡游私人片库喵~",
  Jellyfin: "正在Jellyfin里翻自建媒体库喵~",
  Kodi: "正在Kodi里遥控家庭影院喵~",

  TIDAL: "正在TIDAL里听高码率浪花喵~",
  Deezer: "正在Deezer里挖歌单喵~",
  SoundCloud: "正在SoundCloud里听地下新声音喵~",
  Bandcamp: "正在Bandcamp里支持独立音乐喵~",
  Qobuz: "正在Qobuz里品无损音乐喵~",
  "Pocket Casts": "正在Pocket Casts里追播客喵~",
  Overcast: "正在Overcast里听播客加速喵~",
  AntennaPod: "正在AntennaPod里收听开源播客喵~",
  MusicBee: "正在MusicBee里整理本地曲库喵~",
  Winamp: "正在Winamp里复古播放喵~",
  "FL Studio": "正在FL Studio里种下鼓点喵~",
  "Ableton Live": "正在Ableton Live里触发音乐片段喵~",
  "Logic Pro": "正在Logic Pro里编排音轨喵~",
  GarageBand: "正在GarageBand里玩一间口袋录音棚喵~",
  Reaper: "正在Reaper里精细修音轨喵~",
  MuseScore: "正在MuseScore里写五线谱喵~",
  "Guitar Pro": "正在Guitar Pro里扒谱练琴喵~",

  "Notion Calendar": "正在Notion Calendar里给日程排座位喵~",
  "Google Calendar": "正在Google Calendar里安排未来喵~",
  "Microsoft To Do": "正在Microsoft To Do里清点待办喵~",
  "Apple Notes": "正在Apple备忘录里接住灵感喵~",
  "Google Keep": "正在Google Keep里贴彩色便签喵~",
  Bear: "正在Bear里写干净漂亮的笔记喵~",
  Craft: "正在Craft里把文档做成小作品喵~",
  "Roam Research": "正在Roam里织双向链接喵~",
  Heptabase: "正在Heptabase里铺知识白板喵~",
  Tana: "正在Tana里给信息打超级标签喵~",
  Anytype: "正在Anytype里离线搭知识空间喵~",
  Workflowy: "正在Workflowy里无限缩进想法喵~",
  Joplin: "正在Joplin里同步开源笔记喵~",
  Ulysses: "正在Ulysses里专心写作喵~",
  Scrivener: "正在Scrivener里铺长文大纲喵~",
  "iA Writer": "正在iA Writer里清爽码字喵~",
  Zettlr: "正在Zettlr里写学术Markdown喵~",
  Airtable: "正在Airtable里把表格变数据库喵~",
  Asana: "正在Asana里推进项目小火车喵~",
  ClickUp: "正在ClickUp里把任务收进一个宇宙喵~",
  Linear: "正在Linear里清理issue队列喵~",
  Jira: "正在Jira里移动任务卡片喵~",
  Confluence: "正在Confluence里堆团队知识库喵~",
  OmniFocus: "正在OmniFocus里执行GTD仪式喵~",
  Things: "正在Things里轻轻勾掉待办喵~",
  TickTick: "正在TickTick里追赶番茄钟喵~",
  "滴答清单": "正在滴答清单里安排今日份行动喵~",
  XMind: "正在XMind里展开脑图树枝喵~",
  MindNode: "正在MindNode里梳理想法藤蔓喵~",
  Readwise: "正在Readwise里复习高亮句子喵~",
  "Readwise Reader": "正在Reader里消化待读文章喵~",
  "Raindrop.io": "正在Raindrop里给书签分类喵~",
  Pocket: "正在Pocket里翻稍后阅读喵~",
  Zotero: "正在Zotero里管理论文粮仓喵~",
  Mendeley: "正在Mendeley里整理参考文献喵~",
  MarginNote: "正在MarginNote里拆书做脑图喵~",
  GoodNotes: "正在GoodNotes里手写电子纸喵~",
  Notability: "正在Notability里边录边记喵~",
  "PDF Expert": "正在PDF Expert里批注文档喵~",
  "Adobe Acrobat": "正在Acrobat里处理PDF正事喵~",
  SumatraPDF: "正在SumatraPDF里轻快翻PDF喵~",
  LibreOffice: "正在LibreOffice里开源办公喵~",
  Keynote: "正在Keynote里做苹果味演示喵~",
  Pages: "正在Pages里排一份漂亮文档喵~",

  Audible: "正在Audible里听书旅行喵~",
  Kobo: "正在Kobo里翻电子书喵~",
  "Moon+ Reader": "正在Moon+ Reader里夜读喵~",
  KOReader: "正在KOReader里调阅读参数喵~",
  Libby: "正在Libby里借电子图书喵~",
  Goodreads: "正在Goodreads里给书标记进度喵~",
  起点读书: "正在起点读书里追更喵~",
  番茄小说: "正在番茄小说里刷章节喵~",
  喜马拉雅: "正在喜马拉雅里听故事喵~",
  Medium: "正在Medium里读长文喵~",
  Substack: "正在Substack里看通讯邮件喵~",
  Feedly: "正在Feedly里收割RSS喵~",
  Inoreader: "正在Inoreader里巡阅信息流喵~",

  LinkedIn: "正在LinkedIn里维护职业人设喵~",
  Tumblr: "正在Tumblr里翻旧互联网灵感喵~",
  "Hacker News": "正在Hacker News里围观技术争论喵~",
  "Product Hunt": "正在Product Hunt里看新产品冒泡喵~",
  Dribbble: "正在Dribbble里找设计手感喵~",
  Behance: "正在Behance里逛作品集喵~",
  ArtStation: "正在ArtStation里吸收美术能量喵~",
  Pixiv: "正在Pixiv里翻画师更新喵~",
  Niconico: "正在Niconico里看弹幕漂过喵~",
  AcFun: "正在AcFun里补一点老二次元喵~",
  豆瓣: "正在豆瓣里标记精神坐标喵~",
  即刻: "正在即刻里看同好冒泡喵~",
  少数派: "正在少数派里研究效率工具喵~",
  什么值得买: "正在什么值得买里判断值不值喵~",
  TapTap: "正在TapTap里看游戏口碑喵~",
  雪球: "正在雪球里看市场情绪喵~",
  TradingView: "正在TradingView里盯K线跳舞喵~",
  虎扑: "正在虎扑里围观赛后热帖喵~",
  Letterboxd: "正在Letterboxd里给电影排星星喵~",
  IMDb: "正在IMDb里查演员和片单喵~",
  "YouTube Studio": "正在YouTube Studio里看频道后台喵~",
  哔哩哔哩直播姬: "正在直播姬里准备开播喵~",

  Malwarebytes: "正在Malwarebytes里扫可疑角落喵~",
  "Windows Security": "正在Windows安全中心里巡逻喵~",
  "Microsoft Defender": "正在Defender里守门喵~",
  火绒安全: "正在火绒里拦小广告和小麻烦喵~",
  CCleaner: "正在CCleaner里清扫缓存灰尘喵~",
  Everything: "正在Everything里瞬间找文件喵~",
  Listary: "正在Listary里飞快定位文件喵~",
  PowerToys: "正在PowerToys里打开Windows隐藏装备喵~",
  Alfred: "正在Alfred里召唤快捷动作喵~",
  Raycast: "正在Raycast里用命令启动一天喵~",
  AutoHotkey: "正在AutoHotkey里让按键自动干活喵~",
  Ditto: "正在Ditto里翻剪贴板历史喵~",
  Snipaste: "正在Snipaste里截图钉图喵~",
  ShareX: "正在ShareX里截图上传一条龙喵~",
  WinDirStat: "正在WinDirStat里看硬盘彩色地图喵~",
  CrystalDiskInfo: "正在CrystalDiskInfo里问硬盘健不健康喵~",
  HWiNFO: "正在HWiNFO里看传感器仪表喵~",
  "MSI Afterburner": "正在Afterburner里调显卡风扇喵~",
  "Process Explorer": "正在Process Explorer里追进程喵~",
  "7-Zip": "正在7-Zip里压缩打包喵~",
  WinRAR: "正在WinRAR里和压缩包打交道喵~",
  Rufus: "正在Rufus里制作启动盘喵~",
  Ventoy: "正在Ventoy里塞进一堆ISO喵~",
  VirtualBox: "正在VirtualBox里开一台小虚拟机喵~",
  "VMware Workstation": "正在VMware里管理虚拟实验室喵~",
  "Parallels Desktop": "正在Parallels里让Mac跑另一个系统喵~",

  MEGA: "正在MEGA里搬大文件喵~",
  Box: "正在Box里同步团队资料喵~",
  pCloud: "正在pCloud里整理云端抽屉喵~",
  "iCloud Drive": "正在iCloud Drive里同步苹果文件喵~",
  坚果云: "正在坚果云里同步工作资料喵~",
  Syncthing: "正在Syncthing里点对点同步文件喵~",
  Nextcloud: "正在Nextcloud里经营私有云喵~",
  Rclone: "正在Rclone里搬运云盘数据喵~",
  FileZilla: "正在FileZilla里排队传文件喵~",
  AnyDesk: "正在AnyDesk里远程接管屏幕喵~",
  RustDesk: "正在RustDesk里开源远程控制喵~",
  Parsec: "正在Parsec里低延迟串流喵~",
  Moonlight: "正在Moonlight里串流游戏画面喵~",
  Sunshine: "正在Sunshine里发射串流阳光喵~",
  AirDroid: "正在AirDroid里遥控手机喵~",
  "KDE Connect": "正在KDE Connect里让手机电脑握手喵~",
  LocalSend: "正在LocalSend里局域网快传喵~",
  "Quick Share": "正在Quick Share里隔空丢文件喵~",
  "Toggl Track": "正在Toggl里记录时间去了哪里喵~",

  "Aurora Store": "正在Aurora Store里匿名逛应用喵~",
  "F-Droid": "正在F-Droid里找开源App喵~",
  华为应用市场: "正在华为应用市场里更新应用喵~",
  米家: "正在米家里调智能家居喵~",
  Temu: "正在Temu里刷低价小东西喵~",
  SHEIN: "正在SHEIN里挑穿搭喵~",
  Shopee: "正在Shopee里逛东南亚货架喵~",
  Lazada: "正在Lazada里比较购物车喵~",
  eBay: "正在eBay里淘全球二手喵~",
  Etsy: "正在Etsy里看手作小物喵~",
  AliExpress: "正在AliExpress里跨境淘货喵~",
  "Uber Eats": "正在Uber Eats里寻找外卖救援喵~",
  DoorDash: "正在DoorDash里召唤晚饭喵~",
  Starbucks: "正在Starbucks里点一杯精神燃料喵~",
  瑞幸咖啡: "正在瑞幸里安排咖啡因喵~",
  盒马: "正在盒马里采购冰箱补给喵~",
  "Booking.com": "正在Booking上找落脚点喵~",
  Airbnb: "正在Airbnb里挑临时小窝喵~",
  Tripadvisor: "正在Tripadvisor里看旅行口碑喵~",
  Skyscanner: "正在Skyscanner里追机票价格喵~",
  航旅纵横: "正在航旅纵横里盯航班动态喵~",
  Grab: "正在Grab里叫车或点饭喵~",
  Uber: "正在Uber里叫一辆车喵~",
  PayPal: "正在PayPal里处理跨境付款喵~",
  Wise: "正在Wise里算汇款路线喵~",
  Robinhood: "正在Robinhood里看市场起伏喵~",
  Coinbase: "正在Coinbase里看加密资产喵~",
  Binance: "正在Binance里盯币圈行情喵~",
  MetaMask: "正在MetaMask里确认链上小动作喵~",
  "Ledger Live": "正在Ledger Live里看硬件钱包喵~",

  Moodle: "正在Moodle里交作业看课件喵~",
  Coursera: "正在Coursera里上网课喵~",
  edX: "正在edX里补大学公开课喵~",
  Udemy: "正在Udemy里学一门新技能喵~",
  Duolingo: "正在Duolingo里抢救连续打卡喵~",
  Anki: "正在Anki里复习记忆卡喵~",
  Quizlet: "正在Quizlet里背词条喵~",
  Brilliant: "正在Brilliant里做交互题喵~",
  LeetCode: "正在LeetCode里和算法搏斗喵~",
  HackerRank: "正在HackerRank里刷编程题喵~",
  Codeforces: "正在Codeforces里准备开赛喵~",
  Kaggle: "正在Kaggle里训练数据直觉喵~",
  Overleaf: "正在Overleaf里编译LaTeX喵~",
  GeoGebra: "正在GeoGebra里拖动几何点喵~",
  Desmos: "正在Desmos里画函数曲线喵~",
  QGIS: "正在QGIS里叠地图图层喵~",
  AutoCAD: "正在AutoCAD里画精确线条喵~",
  "Fusion 360": "正在Fusion 360里建模零件喵~",
  SolidWorks: "正在SolidWorks里装配机械结构喵~",
  KiCad: "正在KiCad里画电路板喵~",
  EasyEDA: "正在EasyEDA里布PCB线喵~",

  Fortnite: "正在Fortnite里边建边打喵~",
  "Dota 2": "正在Dota 2里守高地喵~",
  Warframe: "正在Warframe里太空跑酷喵~",
  "Path of Exile": "正在流放之路里研究天赋树喵~",
  "World of Warcraft": "正在艾泽拉斯跑本喵~",
  Hearthstone: "正在炉石里搓一张牌喵~",
  "Diablo IV": "正在庇护之地刷装备喵~",
  "StarCraft II": "正在星际里运营和暴兵喵~",
  "Rainbow Six Siege": "正在彩六里听脚步喵~",
  "Escape from Tarkov": "正在塔科夫里紧张撤离喵~",
  "Helldivers 2": "正在地狱潜兵里传播民主喵~",
  Palworld: "正在Palworld里抓帕鲁打工喵~",
  "Monster Hunter: World": "正在怪猎世界里磨刀追龙喵~",
  "Cyberpunk 2077": "正在夜之城接活喵~",
  "The Witcher 3": "正在巫师3里接狩魔委托喵~",
  "Baldur's Gate 3": "正在博德之门3里掷骰决定命运喵~",
  "Final Fantasy XIV": "正在FF14里排本看剧情喵~",
  "Persona 5 Royal": "正在P5R里偷心喵~",
  "Stardew Valley": "正在星露谷浇水种菜喵~",
  Terraria: "正在泰拉瑞亚里向地下进发喵~",
  Factorio: "正在Factorio里让传送带唱歌喵~",
  RimWorld: "正在RimWorld里管理殖民地日常喵~",
  Hades: "正在Hades里冲出冥界喵~",
  "Hades II": "正在Hades II里挥法杖下潜喵~",
  "Hollow Knight": "正在空洞骑士里探索圣巢喵~",
  Celeste: "正在Celeste里爬山挑战手指喵~",
  Balatro: "正在Balatro里被小丑牌诱惑喵~",
  "Vampire Survivors": "正在吸血鬼幸存者里看满屏数字喵~",
  Satisfactory: "正在Satisfactory里铺工厂传送带喵~",
  "Cities: Skylines": "正在都市天际线里规划堵车喵~",
  "The Sims 4": "正在模拟人生4里安排虚拟日常喵~",
  "Civilization VI": "正在文明6里再来一回合喵~",
  Stellaris: "正在Stellaris里治理星际帝国喵~",
  "Football Manager": "正在FM里当更衣室大脑喵~",
  "Rocket League": "正在火箭联盟里开车踢球喵~",
  "Forza Horizon 5": "正在极限竞速地平线里飙车兜风喵~",
  "Microsoft Flight Simulator": "正在模拟飞行里看云层喵~",
  "Red Dead Redemption 2": "正在荒野大镖客里骑马远行喵~",
  "Grand Theft Auto V": "正在洛圣都自由活动喵~",
  "Lethal Company": "正在致命公司里搬废品喵~",
  Phasmophobia: "正在Phasmophobia里拿设备找鬼喵~",
  "Project Zomboid": "正在僵尸毁灭工程里囤罐头喵~",
  Valheim: "正在Valheim里砍树造屋喵~",
  "The Elder Scrolls V: Skyrim": "正在天际省接任务喵~",
  Starfield: "正在Starfield里跳跃星系喵~",
  "DOOM Eternal": "正在DOOM Eternal里高速清场喵~",
  "Resident Evil 4": "正在生化4里护送阿什莉喵~",
  "Alan Wake 2": "正在Alan Wake 2里追逐黑暗故事喵~",
  Sekiro: "正在只狼里架势对刀喵~",
  "Dark Souls III": "正在黑魂3里谨慎翻滚喵~",
  "Armored Core VI": "正在装甲核心6里改机甲喵~",
  "Black Myth: Wukong": "正在黑神话里抡金箍棒喵~",
  "黑神话：悟空": "正在黑神话里抡金箍棒喵~",
  永劫无间: "正在永劫无间里振刀喵~",
  逆水寒: "正在逆水寒里闯江湖喵~",
  碧蓝航线: "正在碧蓝航线里出击舰队喵~",
  "Blue Archive": "正在蔚蓝档案里当老师喵~",
  "Fate/Grand Order": "正在FGO里抽卡打本喵~",
  雀魂: "正在雀魂里摸牌立直喵~",
  "osu!": "正在osu!里点圈跟节奏喵~",
  "Beat Saber": "正在Beat Saber里挥光剑切方块喵~",
  VRChat: "正在VRChat里换世界社交喵~",

  "Dolphin Emulator": "正在Dolphin里复活NGC和Wii喵~",
  PCSX2: "正在PCSX2里读取PS2回忆喵~",
  PPSSPP: "正在PPSSPP里掌机怀旧喵~",
  RPCS3: "正在RPCS3里挑战PS3模拟喵~",
  RetroArch: "正在RetroArch里打开全能怀旧柜喵~",
  ScummVM: "正在ScummVM里玩老冒险游戏喵~",
  "Live2D Cubism": "正在Live2D里给角色绑骨喵~",
  "Ren'Py": "正在Ren'Py里跑视觉小说喵~",

  "FANZA Games": "正在FANZA Games里挑成人向游戏喵~",
  "DMM Game Player": "正在DMM Game Player里启动日系游戏喵~",
  "DLsite Nest": "正在DLsite Nest里管理同人作品喵~",
  "DLsite Play": "正在DLsite Play里浏览同人内容喵~",
  Nutaku: "正在Nutaku里逛成人向游戏库喵~",
  "JAST USA": "正在JAST USA里看视觉小说收藏喵~",
  MangaGamer: "正在MangaGamer里翻译系视觉小说喵~",
  Denpasoft: "正在Denpasoft里逛绅士向商店喵~",
  FAKKU: "正在FAKKU里浏览成人漫画库喵~",
  Iwara: "正在Iwara里看舞蹈视频喵~",
  "E-Hentai": "正在E-Hentai里翻图册喵~",
  nhentai: "正在nhentai里按编号找本子喵~",
  "Hitomi Downloader": "正在Hitomi Downloader里整理下载队列喵~",
  "Hydrus Network": "正在Hydrus里给图片收藏打标签喵~",
  "Honey Select 2": "正在Honey Select 2里捏角色场景喵~",
  "Koikatsu Party": "正在Koikatsu里捏二次元角色喵~",
  "Custom Order Maid 3D2": "正在COM3D2里调角色和场景喵~",
  "VR Kanojo": "正在VR Kanojo里体验VR互动喵~",
  "HuniePop": "正在HuniePop里玩三消约会喵~",
  "HuniePop 2": "正在HuniePop 2里连三消喵~",
  Subverse: "正在Subverse里跑太空成人向剧情喵~",
  "Action Taimanin": "正在Action Taimanin里打动作关卡喵~",
  "Rance X": "正在Rance X里推进老牌RPG剧情喵~",
  Evenicle: "正在Evenicle里跑奇幻RPG冒险喵~",
};

for (const [name, description] of Object.entries(personalizedDescriptions)) {
  descriptions[name] = description;
}

const DEFAULT_DESCRIPTION = "暂时看不到具体活动喵~";
const NSFW_MASKED_DESCRIPTION = "正在处理一点不方便展开的私密内容喵~";
const ADULT_APP_NAME_SET = new Set(ADULT_APP_NAMES.map((name) => name.toLowerCase()));
const ADULT_APP_ID_SET = new Set([
  "com.pornhub.android",
  "com.xvideos.app",
  "com.xhamster.app",
]);
const ADULT_DOMAINS = [
  "pornhub.com", "xvideos.com", "xhamster.com", "xnxx.com", "redtube.com",
  "youporn.com", "tube8.com", "spankbang.com", "eporner.com", "tnaflix.com",
  "nhentai.net", "hanime.tv", "hentaihaven.xxx", "rule34.xxx", "e-hentai.org",
  "exhentai.org", "gelbooru.com", "danbooru.donmai.us", "hitomi.la", "javbus.com",
  "javdb.com", "avgle.com", "missav.com", "thisav.com", "jable.tv",
  "91porn.com", "sex.com", "chaturbate.com", "stripchat.com", "cam4.com",
  "bongacams.com", "onlyfans.com", "fansly.com", "iwara.tv",
];
const ADULT_KEYWORDS = [
  "pornhub", "xvideos", "xhamster", "nhentai", "hentai", "hanime",
  "rule34", "e-hentai", "exhentai", "gelbooru", "danbooru", "javbus",
  "javdb", "missav", "91porn", "onlyfans", "fansly", "chaturbate", "stripchat",
  "fanza", "dlsite", "nutaku", "fakku", "denpasoft", "mangagamer", "jast usa",
  "koikatsu", "honey select", "custom order maid", "vr kanojo", "huniepop",
  "taimanin", "rance x", "evenicle",
];

function containsAdultSignal(value: string | undefined): boolean {
  const text = (value || "").trim().toLowerCase();
  if (!text) return false;
  if (ADULT_APP_NAME_SET.has(text) || ADULT_APP_ID_SET.has(text)) return true;
  return ADULT_DOMAINS.some((domain) => text.includes(domain)) ||
    ADULT_KEYWORDS.some((keyword) => text.includes(keyword));
}

export function shouldMaskAppDescription(appName: string, appId?: string, displayTitle?: string): boolean {
  return containsAdultSignal(appName) ||
    containsAdultSignal(appId) ||
    containsAdultSignal(displayTitle);
}

// Pre-build lowercase index for O(1) lookups
const lowerIndex = new Map<string, string>();
for (const [key, value] of Object.entries(descriptions)) {
  lowerIndex.set(key.toLowerCase(), value);
}

const ACTION_PREFIX_RE = /^(正在|在)(用|玩|看|听|浏览|阅读|写|剪|修|画|搞|开|聊|搜|刷|逛|下载|同步|办公|调|管理)/;
const UNKNOWN_APP_NAMES = new Set(["unknown", "未知", "null", "undefined"]);

function withCuteSuffix(text: string): string {
  const cleaned = text.trim().replace(/[~～。.!！]+$/g, "");
  return cleaned.endsWith("喵") ? `${cleaned}~` : `${cleaned}喵~`;
}

function normalizeDisplayTitle(appName: string, displayTitle?: string): string {
  const title = (displayTitle || "").trim().replace(/\s+/g, " ");
  if (!title) return "";

  const normalized = title.toLowerCase();
  const app = appName.trim().toLowerCase();
  if (isGenericVisibleTitle(title)) return "";
  if (normalized === app || normalized === "android" || normalized.endsWith("activity")) return "";
  if (isGenericAppTitle(appName, title)) return "";
  if (title === `正在用${appName}` || title.startsWith("正在用系统桌面")) return "";
  if (isRedundantGeneratedTitle(appName, title)) return "";
  return title;
}

function isGenericVisibleTitle(title: string): boolean {
  const normalized = title.trim().replace(/[~～。.!！]+$/g, "~");
  return normalized === "暂时看不到具体活动喵~" || normalized === "暂时离开了一会儿喵~";
}

function isGenericAppTitle(appName: string, title: string): boolean {
  const app = appName.trim().toLowerCase();
  const normalized = title.trim().toLowerCase();
  if (!app || !normalized) return false;
  if ((app.includes("浏览器") || app.includes("browser")) && (normalized === "浏览器" || normalized === "browser")) return true;
  if ((app.includes("音乐") || app.includes("music")) && (normalized === "音乐" || normalized === "music")) return true;
  return false;
}

function isRedundantGeneratedTitle(appName: string, title: string): boolean {
  const stripped = title.trim().replace(/[~～。.!！]+$/g, "");
  const app = appName.trim();
  if (!app) return false;
  const patterns = [
    `正在用${app}看${app}`,
    `正在用${app}浏览${app}`,
    `正在用${app}看「${app}」`,
    `正在用${app}浏览「${app}」`,
  ];
  if (patterns.includes(stripped)) return true;
  if (app.includes("浏览器")) {
    return stripped === "正在用浏览器看浏览器" ||
      stripped === "正在用浏览器浏览浏览器" ||
      stripped === "正在用浏览器看「浏览器」" ||
      stripped === "正在用浏览器浏览「浏览器」";
  }
  return false;
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
  (t) => `正在YouTube看「${t}」喵~`
);
registerTemplate(
  ["哔哩哔哩", "bilibili"],
  (t) => `正在B站看「${t}」喵~`
);
registerTemplate(
  ["Netflix"],
  (t) => `正在Netflix看「${t}」喵~`
);
registerTemplate(
  ["爱奇艺"],
  (t) => `正在爱奇艺看「${t}」喵~`
);
registerTemplate(
  ["优酷"],
  (t) => `正在优酷看「${t}」喵~`
);
registerTemplate(
  ["腾讯视频"],
  (t) => `正在腾讯视频看「${t}」喵~`
);
registerTemplate(
  ["VLC", "PotPlayer", "mpv"],
  (t) => `正在看「${t}」喵~`
);
// New video platforms
registerTemplate(
  ["Twitch"],
  (t) => `正在Twitch看「${t}」喵~`
);
registerTemplate(
  ["Disney+"],
  (t) => `正在Disney+看「${t}」喵~`
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
  (t) => `正在Spotify听「${t}」喵~`
);
registerTemplate(
  ["网易云音乐"],
  (t) => `正在网易云听「${t}」喵~`
);
registerTemplate(
  ["QQ音乐"],
  (t) => `正在QQ音乐听「${t}」喵~`
);
registerTemplate(
  ["酷狗音乐"],
  (t) => `正在酷狗听「${t}」喵~`
);
registerTemplate(
  ["Apple Music"],
  (t) => `正在Apple Music听「${t}」喵~`
);
registerTemplate(
  ["foobar2000"],
  (t) => `正在听「${t}」喵~`
);
registerTemplate(
  ["YouTube Music"],
  (t) => `正在YouTube Music听「${t}」喵~`
);
registerTemplate(
  ["酷我音乐"],
  (t) => `正在酷我听「${t}」喵~`
);
registerTemplate(
  ["Amazon Music"],
  (t) => `正在Amazon Music听「${t}」喵~`
);
registerTemplate(
  ["AIMP"],
  (t) => `正在听「${t}」喵~`
);

// Chat and AI assistants
registerTemplate(
  ["Telegram", "QQ", "TIM", "微信", "WeChat", "Discord", "Line", "Slack", "飞书", "Lark", "企业微信", "钉钉"],
  (t) => `正在聊「${t}」喵~`
);
registerTemplate(
  ["ChatGPT", "Claude", "Gemini", "Copilot", "Microsoft Copilot", "DeepSeek", "Kimi", "豆包", "通义千问", "文心一言", "Poe", "Perplexity"],
  (t) => `正在和AI推敲「${t}」喵~`
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
  (t) => `正在写「${t}」喵~`
);
registerTemplate(
  ["Sublime Text"],
  (t) => `正在用Sublime写「${t}」喵~`
);
registerTemplate(
  ["Visual Studio"],
  (t) => `正在用VS写「${t}」喵~`
);
registerTemplate(
  ["Google Antigravity"],
  (t) => `正在用Antigravity写「${t}」喵~`
);
registerTemplate(
  ["Windsurf"],
  (t) => `正在用Windsurf写「${t}」喵~`
);
registerTemplate(
  ["Zed"],
  (t) => `正在用Zed写「${t}」喵~`
);
registerTemplate(
  ["CLion", "RustRover", "JetBrains Fleet", "HBuilderX"],
  (t) => `正在写「${t}」喵~`
);
registerTemplate(
  ["Vim", "Neovim"],
  (t) => `正在用Vim写「${t}」喵~`
);
registerTemplate(
  ["Emacs"],
  (t) => `正在用Emacs写「${t}」喵~`
);
registerTemplate(
  ["Notepad++"],
  (t) => `正在用Notepad++写「${t}」喵~`
);

// Dev tools
registerTemplate(
  ["Docker Desktop"],
  (t) => `正在用Docker搞「${t}」喵~`
);
registerTemplate(
  ["GitHub Desktop"],
  (t) => `正在GitHub上搞「${t}」喵~`
);
registerTemplate(
  ["Postman"],
  (t) => `正在用Postman调「${t}」喵~`
);
registerTemplate(
  ["DBeaver", "Navicat"],
  (t) => `正在查「${t}」数据库喵~`
);
registerTemplate(
  ["Insomnia"],
  (t) => `正在用Insomnia调「${t}」喵~`
);
registerTemplate(
  ["GitKraken"],
  (t) => `正在用GitKraken搞「${t}」喵~`
);
registerTemplate(
  ["Sourcetree"],
  (t) => `正在用Sourcetree搞「${t}」喵~`
);
registerTemplate(
  ["Windows Terminal", "终端", "Terminal", "PowerShell", "命令提示符", "Command Prompt", "iTerm2", "Alacritty", "Kitty", "Termux", "Warp"],
  (t) => `正在终端里跑「${t}」喵~`
);

// Gaming platforms — displayTitle IS the game title
registerTemplate(
  ["Steam"],
  (t) => `正在Steam玩「${t}」喵~`
);
registerTemplate(
  ["Epic Games"],
  (t) => `正在Epic玩「${t}」喵~`
);
registerTemplate(
  ["GOG Galaxy"],
  (t) => `正在GOG玩「${t}」喵~`
);
registerTemplate(
  ["Xbox"],
  (t) => `正在Xbox玩「${t}」喵~`
);
registerTemplate(
  ["EA App"],
  (t) => `正在EA玩「${t}」喵~`
);
registerTemplate(
  ["Ubisoft Connect"],
  (t) => `正在育碧玩「${t}」喵~`
);
registerTemplate(
  ["Battle.net"],
  (t) => `正在暴雪玩「${t}」喵~`
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
  (t) => `正在攻略「${t}」喵~`
);

// Productivity
registerTemplate(
  ["Word", "Microsoft Word"],
  (t) => `正在用Word写「${t}」喵~`
);
registerTemplate(
  ["Excel", "Microsoft Excel"],
  (t) => `正在用Excel看「${t}」喵~`
);
registerTemplate(
  ["PowerPoint", "Microsoft PowerPoint"],
  (t) => `正在做「${t}」PPT喵~`
);
registerTemplate(
  ["OneNote"],
  (t) => `正在OneNote写「${t}」喵~`
);
registerTemplate(
  ["Notion"],
  (t) => `正在Notion看「${t}」喵~`
);
registerTemplate(
  ["Obsidian"],
  (t) => `正在Obsidian写「${t}」喵~`
);
registerTemplate(
  ["Typora"],
  (t) => `正在Typora写「${t}」喵~`
);
registerTemplate(
  ["WPS Office", "WPS"],
  (t) => `正在用WPS写「${t}」喵~`
);
registerTemplate(
  ["Google Docs"],
  (t) => `正在Google文档写「${t}」喵~`
);
registerTemplate(
  ["Logseq"],
  (t) => `正在Logseq写「${t}」喵~`
);

// Design tools
registerTemplate(
  ["Figma"],
  (t) => `正在用Figma做「${t}」喵~`
);
registerTemplate(
  ["Photoshop", "Adobe Photoshop"],
  (t) => `正在用Photoshop修「${t}」喵~`
);
registerTemplate(
  ["Illustrator", "Adobe Illustrator"],
  (t) => `正在用Illustrator画「${t}」喵~`
);
registerTemplate(
  ["Premiere Pro", "Adobe Premiere Pro"],
  (t) => `正在用Premiere剪「${t}」喵~`
);
registerTemplate(
  ["After Effects", "Adobe After Effects"],
  (t) => `正在用AE做「${t}」喵~`
);
registerTemplate(
  ["Blender"],
  (t) => `正在用Blender搞「${t}」喵~`
);
registerTemplate(
  ["DaVinci Resolve"],
  (t) => `正在用达芬奇剪「${t}」喵~`
);
registerTemplate(
  ["剪映", "CapCut"],
  (t) => `正在用剪映剪「${t}」喵~`
);
registerTemplate(
  ["Lightroom", "Adobe Lightroom"],
  (t) => `正在用Lightroom修「${t}」喵~`
);
registerTemplate(
  ["SAI", "Clip Studio Paint", "MediBang", "Krita"],
  (t) => `正在画「${t}」喵~`
);

// Reading
registerTemplate(
  ["Kindle"],
  (t) => `正在Kindle看「${t}」喵~`
);
registerTemplate(
  ["微信读书"],
  (t) => `正在微信读书看「${t}」喵~`
);

// Browser — when display_title is available (video site page, generic page title)
registerTemplate(
  ["Google Chrome", "Chrome"],
  (t) => `正在用Chrome浏览「${t}」喵~`
);
registerTemplate(
  ["Microsoft Edge"],
  (t) => `正在用Edge浏览「${t}」喵~`
);
registerTemplate(
  ["Firefox"],
  (t) => `正在用Firefox浏览「${t}」喵~`
);
registerTemplate(
  ["Safari", "Opera", "Arc"],
  (t) => `正在浏览「${t}」喵~`
);
registerTemplate(
  ["Brave"],
  (t) => `正在用Brave浏览「${t}」喵~`
);
registerTemplate(
  ["Vivaldi"],
  (t) => `正在用Vivaldi浏览「${t}」喵~`
);
registerTemplate(
  ["浏览器", "小米浏览器", "Samsung Internet", "DuckDuckGo", "Via", "Kiwi Browser", "Quark", "UC Browser", "HeyTap Browser", "Vivo Browser", "Huawei Browser"],
  (t) => `正在用浏览器看「${t}」喵~`
);

export function getAppDescription(
  appName: string,
  displayTitle?: string,
  music?: { title?: string; artist?: string; app?: string },
  options?: { nsfwFilterEnabled?: boolean; appId?: string },
): string {
  if (!appName) return DEFAULT_DESCRIPTION;
  if (options?.nsfwFilterEnabled !== false && shouldMaskAppDescription(appName, options?.appId, displayTitle)) {
    return NSFW_MASKED_DESCRIPTION;
  }

  const appLower = appName.toLowerCase();
  const isMusicAppForeground = _musicAppNames.has(appLower);
  const title = normalizeDisplayTitle(appName, displayTitle);

  // Base description (with or without display title)
  let base: string | undefined;

  // If we have a display_title, try to use a rich template
  // BUT skip template for music apps when music extra is present (♪ line handles song info)
  if (title && !(isMusicAppForeground && music?.title)) {
    if (ACTION_PREFIX_RE.test(title)) {
      base = withCuteSuffix(title);
    }
    const template = titleTemplates.get(appLower);
    if (!base && template) {
      base = template(title);
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
    if (title) {
      base = ACTION_PREFIX_RE.test(title) ? withCuteSuffix(title) : `正在看「${title}」喵~`;
    } else if (!UNKNOWN_APP_NAMES.has(appLower)) {
      base = `正在用${appName}喵~`;
    } else {
      base = DEFAULT_DESCRIPTION;
    }
  }

  // Music info is shown via the ♪ line in CurrentStatus, so no need to embed it in description

  return base;
}
