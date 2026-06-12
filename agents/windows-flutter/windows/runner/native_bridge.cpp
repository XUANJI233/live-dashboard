#include "native_bridge.h"

#include <bcrypt.h>
#include <flutter/method_channel.h>
#include <flutter/standard_method_codec.h>
#include <shobjidl.h>
#include <shellapi.h>
#include <windows.h>

#include <filesystem>
#include <fstream>
#include <cwctype>
#include <memory>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "flutter_window.h"
#include "utils.h"

namespace {
using flutter::EncodableMap;
using flutter::EncodableValue;
using flutter::MethodCall;
using flutter::MethodResult;
using NativeMethodChannel = flutter::MethodChannel<EncodableValue>;

constexpr wchar_t kConfigPath[] = L"Software\\LiveDashboardAgent";
constexpr wchar_t kRunPath[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr wchar_t kRunName[] = L"LiveDashboardAgent";
std::vector<std::unique_ptr<NativeMethodChannel>> g_channels;

std::wstring Utf16FromUtf8(const std::string& input) {
  if (input.empty()) {
    return L"";
  }
  int size = ::MultiByteToWideChar(CP_UTF8, 0, input.data(),
                                   static_cast<int>(input.size()), nullptr, 0);
  std::wstring output(size, L'\0');
  ::MultiByteToWideChar(CP_UTF8, 0, input.data(), static_cast<int>(input.size()),
                        output.data(), size);
  return output;
}

std::string Narrow(const std::wstring& input) {
  return Utf8FromUtf16(input.c_str());
}

std::wstring EnvValue(const wchar_t* name) {
  DWORD size = ::GetEnvironmentVariableW(name, nullptr, 0);
  if (size == 0) {
    return L"";
  }
  std::wstring value(size, L'\0');
  DWORD written = ::GetEnvironmentVariableW(name, value.data(), size);
  value.resize(written);
  return value;
}

std::wstring ModulePath() {
  std::wstring path(MAX_PATH, L'\0');
  DWORD size = ::GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
  path.resize(size);
  return path;
}

std::wstring ParentPath(const std::wstring& path) {
  return std::filesystem::path(path).parent_path().wstring();
}

std::string StringArg(const EncodableMap& args, const char* name) {
  auto it = args.find(EncodableValue(name));
  if (it == args.end() || !std::holds_alternative<std::string>(it->second)) {
    return "";
  }
  return std::get<std::string>(it->second);
}

bool BoolArg(const EncodableMap& args, const char* name) {
  auto it = args.find(EncodableValue(name));
  return it != args.end() && std::holds_alternative<bool>(it->second) &&
         std::get<bool>(it->second);
}

int IntArg(const EncodableMap& args, const char* name, int fallback) {
  auto it = args.find(EncodableValue(name));
  if (it == args.end()) {
    return fallback;
  }
  if (std::holds_alternative<int32_t>(it->second)) {
    return std::get<int32_t>(it->second);
  }
  if (std::holds_alternative<int64_t>(it->second)) {
    return static_cast<int>(std::get<int64_t>(it->second));
  }
  return fallback;
}

HKEY RootForScope(const std::string& scope) {
  return scope == "all_users" ? HKEY_LOCAL_MACHINE : HKEY_CURRENT_USER;
}

std::wstring ReadRegString(HKEY root, const wchar_t* path, const wchar_t* name) {
  DWORD size = 0;
  if (::RegGetValueW(root, path, name, RRF_RT_REG_SZ, nullptr, nullptr, &size) != ERROR_SUCCESS || size == 0) {
    return L"";
  }
  std::wstring value(size / sizeof(wchar_t), L'\0');
  if (::RegGetValueW(root, path, name, RRF_RT_REG_SZ, nullptr, value.data(), &size) != ERROR_SUCCESS) {
    return L"";
  }
  while (!value.empty() && value.back() == L'\0') {
    value.pop_back();
  }
  return value;
}

DWORD ReadRegDword(HKEY root, const wchar_t* path, const wchar_t* name, DWORD fallback) {
  DWORD value = fallback;
  DWORD size = sizeof(value);
  ::RegGetValueW(root, path, name, RRF_RT_REG_DWORD, nullptr, &value, &size);
  return value;
}

void WriteRegString(HKEY root, const wchar_t* path, const wchar_t* name, const std::wstring& value) {
  HKEY key = nullptr;
  if (::RegCreateKeyExW(root, path, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS) {
    return;
  }
  ::RegSetValueExW(key, name, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
                   static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
  ::RegCloseKey(key);
}

void WriteRegDword(HKEY root, const wchar_t* path, const wchar_t* name, DWORD value) {
  HKEY key = nullptr;
  if (::RegCreateKeyExW(root, path, 0, nullptr, 0, KEY_SET_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS) {
    return;
  }
  ::RegSetValueExW(key, name, 0, REG_DWORD, reinterpret_cast<const BYTE*>(&value), sizeof(value));
  ::RegCloseKey(key);
}

void DeleteIfExists(const std::wstring& path) {
  if (!path.empty()) {
    ::DeleteFileW(path.c_str());
  }
}

void CleanupLegacyStartupFiles(const std::string& scope) {
  std::vector<std::wstring> directories;
  std::wstring appdata = EnvValue(L"APPDATA");
  if (!appdata.empty()) {
    directories.push_back(appdata + L"\\Microsoft\\Windows\\Start Menu\\Programs\\Startup");
  }
  if (scope == "all_users") {
    std::wstring program_data = EnvValue(L"PROGRAMDATA");
    if (!program_data.empty()) {
      directories.push_back(program_data + L"\\Microsoft\\Windows\\Start Menu\\Programs\\Startup");
    }
  }
  const std::vector<std::wstring> names = {
      L"LiveDashboardAgent.lnk",
      L"Live Dashboard Agent.lnk",
      L"live-dashboard-agent.lnk",
      L"LiveDashboardAgent.cmd",
      L"Live Dashboard Agent.cmd",
      L"live-dashboard-agent.cmd",
  };
  for (const auto& directory : directories) {
    for (const auto& name : names) {
      DeleteIfExists(directory + L"\\" + name);
    }
  }
}

void DeleteLegacyScheduledTask() {
  STARTUPINFOW startup{};
  PROCESS_INFORMATION process{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESHOWWINDOW;
  startup.wShowWindow = SW_HIDE;
  std::wstring command = L"schtasks.exe /Delete /TN LiveDashboardAgent /F";
  if (::CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE,
                       CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process)) {
    ::WaitForSingleObject(process.hProcess, 3000);
    ::CloseHandle(process.hThread);
    ::CloseHandle(process.hProcess);
  }
}

EncodableValue ReadConfig() {
  EncodableMap map;
  map[EncodableValue("server_url")] = EncodableValue(Narrow(ReadRegString(HKEY_CURRENT_USER, kConfigPath, L"ServerUrl")));
  map[EncodableValue("token")] = EncodableValue(Narrow(ReadRegString(HKEY_CURRENT_USER, kConfigPath, L"Token")));
  map[EncodableValue("interval_seconds")] = EncodableValue(static_cast<int32_t>(ReadRegDword(HKEY_CURRENT_USER, kConfigPath, L"IntervalSeconds", 5)));
  map[EncodableValue("heartbeat_seconds")] = EncodableValue(static_cast<int32_t>(ReadRegDword(HKEY_CURRENT_USER, kConfigPath, L"HeartbeatSeconds", 60)));
  map[EncodableValue("idle_threshold_seconds")] = EncodableValue(static_cast<int32_t>(ReadRegDword(HKEY_CURRENT_USER, kConfigPath, L"IdleThresholdSeconds", 300)));
  map[EncodableValue("enable_log")] = EncodableValue(ReadRegDword(HKEY_CURRENT_USER, kConfigPath, L"EnableLog", 0) == 1);
  return EncodableValue(map);
}

void WriteConfig(const EncodableMap& args) {
  WriteRegString(HKEY_CURRENT_USER, kConfigPath, L"ServerUrl", Utf16FromUtf8(StringArg(args, "server_url")));
  WriteRegString(HKEY_CURRENT_USER, kConfigPath, L"Token", Utf16FromUtf8(StringArg(args, "token")));
  WriteRegDword(HKEY_CURRENT_USER, kConfigPath, L"IntervalSeconds", IntArg(args, "interval_seconds", 5));
  WriteRegDword(HKEY_CURRENT_USER, kConfigPath, L"HeartbeatSeconds", IntArg(args, "heartbeat_seconds", 60));
  WriteRegDword(HKEY_CURRENT_USER, kConfigPath, L"IdleThresholdSeconds", IntArg(args, "idle_threshold_seconds", 300));
  WriteRegDword(HKEY_CURRENT_USER, kConfigPath, L"EnableLog", BoolArg(args, "enable_log") ? 1 : 0);
}

EncodableValue GetPaths() {
  std::wstring exe = ModulePath();
  std::wstring base = ParentPath(exe);
  EncodableMap map;
  map[EncodableValue("executable_path")] = EncodableValue(Narrow(exe));
  map[EncodableValue("base_directory")] = EncodableValue(Narrow(base));
  map[EncodableValue("log_directory")] = EncodableValue(Narrow(base + L"\\logs"));
  return EncodableValue(map);
}

std::wstring ForegroundProcessName(HWND hwnd) {
  DWORD pid = 0;
  ::GetWindowThreadProcessId(hwnd, &pid);
  HANDLE process = ::OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) {
    return L"unknown";
  }
  std::wstring path(32768, L'\0');
  DWORD size = static_cast<DWORD>(path.size());
  if (!::QueryFullProcessImageNameW(process, 0, path.data(), &size)) {
    ::CloseHandle(process);
    return L"unknown";
  }
  ::CloseHandle(process);
  path.resize(size);
  return std::filesystem::path(path).filename().wstring();
}

std::wstring WindowTitle(HWND hwnd) {
  if (!hwnd) {
    return L"";
  }
  int length = ::GetWindowTextLengthW(hwnd);
  if (length <= 0) {
    return L"";
  }
  std::wstring title(length + 1, L'\0');
  ::GetWindowTextW(hwnd, title.data(), length + 1);
  while (!title.empty() && title.back() == L'\0') {
    title.pop_back();
  }
  return title;
}

std::wstring Trim(const std::wstring& value) {
  const wchar_t* whitespace = L" \t\r\n";
  size_t start = value.find_first_not_of(whitespace);
  if (start == std::wstring::npos) {
    return L"";
  }
  size_t end = value.find_last_not_of(whitespace);
  return value.substr(start, end - start + 1);
}

bool EqualsIgnoreCase(const std::wstring& left, const std::wstring& right) {
  return _wcsicmp(left.c_str(), right.c_str()) == 0;
}

std::wstring RemoveTrailingFoobarSuffix(const std::wstring& value) {
  std::wstring lower = value;
  for (auto& character : lower) {
    character = static_cast<wchar_t>(towlower(character));
  }
  const std::wstring marker = L"[foobar2000";
  size_t index = lower.rfind(marker);
  return index == std::wstring::npos ? Trim(value) : Trim(value.substr(0, index));
}

bool SplitTitle(const std::wstring& value, std::wstring* first, std::wstring* second) {
  size_t index = value.find(L" - ");
  if (index == std::wstring::npos) {
    return false;
  }
  *first = Trim(value.substr(0, index));
  *second = Trim(value.substr(index + 3));
  return true;
}

EncodableMap MusicMap(const std::wstring& app,
                      const std::wstring& title,
                      const std::wstring& artist) {
  EncodableMap map;
  map[EncodableValue("app")] = EncodableValue(Narrow(app));
  if (!title.empty()) {
    map[EncodableValue("title")] = EncodableValue(Narrow(title.substr(0, 256)));
  }
  if (!artist.empty()) {
    map[EncodableValue("artist")] = EncodableValue(Narrow(artist.substr(0, 256)));
  }
  return map;
}

bool ParseMusicTitle(const std::wstring& process_name,
                     const std::wstring& window_title,
                     const std::wstring& app,
                     EncodableMap* output) {
  if (EqualsIgnoreCase(process_name, L"spotify.exe")) {
    if (EqualsIgnoreCase(window_title, L"Spotify") ||
        EqualsIgnoreCase(window_title, L"Spotify Free") ||
        EqualsIgnoreCase(window_title, L"Spotify Premium")) {
      return false;
    }
    std::wstring artist;
    std::wstring title;
    if (SplitTitle(window_title, &artist, &title)) {
      *output = MusicMap(app, title, artist);
      return true;
    }
    *output = MusicMap(app, Trim(window_title), L"");
    return true;
  }

  if (EqualsIgnoreCase(process_name, L"foobar2000.exe")) {
    std::wstring cleaned = RemoveTrailingFoobarSuffix(window_title);
    if (cleaned.empty()) {
      return false;
    }
    std::wstring artist;
    std::wstring title;
    if (SplitTitle(cleaned, &artist, &title)) {
      *output = MusicMap(app, title, artist);
      return true;
    }
    *output = MusicMap(app, cleaned, L"");
    return true;
  }

  if (EqualsIgnoreCase(window_title, app)) {
    return false;
  }
  std::wstring title;
  std::wstring artist;
  if (SplitTitle(window_title, &title, &artist)) {
    *output = MusicMap(app, title, artist);
    return true;
  }
  *output = MusicMap(app, Trim(window_title), L"");
  return true;
}

EncodableMap DetectMusic() {
  static const std::vector<std::pair<const wchar_t*, const wchar_t*>> music_processes = {
      {L"spotify.exe", L"Spotify"},
      {L"qqmusic.exe", L"QQ Music"},
      {L"cloudmusic.exe", L"NetEase Cloud Music"},
      {L"foobar2000.exe", L"foobar2000"},
      {L"itunes.exe", L"Apple Music"},
      {L"applemusic.exe", L"Apple Music"},
      {L"kugou.exe", L"Kugou Music"},
      {L"kwmusic.exe", L"Kuwo Music"},
      {L"aimp.exe", L"AIMP"},
      {L"musicbee.exe", L"MusicBee"},
      {L"vlc.exe", L"VLC"},
      {L"potplayer.exe", L"PotPlayer"},
      {L"potplayer64.exe", L"PotPlayer"},
      {L"potplayermini.exe", L"PotPlayer"},
      {L"potplayermini64.exe", L"PotPlayer"},
      {L"wmplayer.exe", L"Windows Media Player"},
  };

  struct SearchState {
    const std::vector<std::pair<const wchar_t*, const wchar_t*>>* processes;
    EncodableMap result;
    bool found = false;
  } state{&music_processes};

  ::EnumWindows([](HWND hwnd, LPARAM lparam) -> BOOL {
    auto* state = reinterpret_cast<SearchState*>(lparam);
    if (!::IsWindowVisible(hwnd)) {
      return TRUE;
    }
    std::wstring title = WindowTitle(hwnd);
    if (Trim(title).empty()) {
      return TRUE;
    }
    std::wstring process = ForegroundProcessName(hwnd);
    for (const auto& item : *state->processes) {
      if (!EqualsIgnoreCase(process, item.first)) {
        continue;
      }
      EncodableMap parsed;
      if (ParseMusicTitle(process, title, item.second, &parsed)) {
        state->result = std::move(parsed);
        state->found = true;
        return FALSE;
      }
    }
    return TRUE;
  }, reinterpret_cast<LPARAM>(&state));

  return state.found ? state.result : EncodableMap{};
}

EncodableValue ProbeActivity() {
  HWND hwnd = ::GetForegroundWindow();
  std::wstring title = WindowTitle(hwnd);
  LASTINPUTINFO last_input{};
  last_input.cbSize = sizeof(last_input);
  DWORD idle_seconds = 0;
  if (::GetLastInputInfo(&last_input)) {
    idle_seconds = (::GetTickCount() - last_input.dwTime) / 1000;
  }
  bool fullscreen = false;
  if (hwnd) {
    RECT window_rect{};
    MONITORINFO monitor_info{};
    monitor_info.cbSize = sizeof(monitor_info);
    HMONITOR monitor = ::MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    if (::GetWindowRect(hwnd, &window_rect) && ::GetMonitorInfoW(monitor, &monitor_info)) {
      fullscreen = window_rect.left <= monitor_info.rcMonitor.left &&
                   window_rect.top <= monitor_info.rcMonitor.top &&
                   window_rect.right >= monitor_info.rcMonitor.right &&
                   window_rect.bottom >= monitor_info.rcMonitor.bottom;
    }
  }
  SYSTEM_POWER_STATUS power{};
  bool has_power = ::GetSystemPowerStatus(&power) == TRUE;
  EncodableMap map;
  map[EncodableValue("app_id")] = EncodableValue(Narrow(ForegroundProcessName(hwnd)));
  map[EncodableValue("window_title")] = EncodableValue(Narrow(title));
  map[EncodableValue("idle_seconds")] = EncodableValue(static_cast<int32_t>(idle_seconds));
  map[EncodableValue("audio_playing")] = EncodableValue(false);
  map[EncodableValue("foreground_fullscreen")] = EncodableValue(fullscreen);
  EncodableMap music = DetectMusic();
  if (!music.empty()) {
    map[EncodableValue("music")] = EncodableValue(music);
  }
  if (has_power && power.BatteryLifePercent != 255) {
    map[EncodableValue("battery_percent")] = EncodableValue(static_cast<int32_t>(power.BatteryLifePercent));
    map[EncodableValue("battery_charging")] = EncodableValue((power.ACLineStatus == 1));
  }
  return EncodableValue(map);
}

bool SetStartup(const EncodableMap& args) {
  HKEY root = RootForScope(StringArg(args, "scope"));
  std::string scope = StringArg(args, "scope");
  bool enabled = BoolArg(args, "enabled");
  HKEY key = nullptr;
  if (::RegCreateKeyExW(root, kRunPath, 0, nullptr, 0, KEY_SET_VALUE | KEY_QUERY_VALUE, nullptr, &key, nullptr) != ERROR_SUCCESS) {
    return false;
  }
  ::RegDeleteValueW(key, L"live-dashboard-agent");
  ::RegDeleteValueW(key, L"Live Dashboard Agent");
  CleanupLegacyStartupFiles(scope);
  DeleteLegacyScheduledTask();
  if (!enabled) {
    ::RegDeleteValueW(key, kRunName);
    ::RegCloseKey(key);
    return true;
  }
  std::wstring executable = Utf16FromUtf8(StringArg(args, "executable_path"));
  std::wstring command = L"\"" + executable + L"\"";
  LSTATUS status = ::RegSetValueExW(key, kRunName, 0, REG_SZ,
                                    reinterpret_cast<const BYTE*>(command.c_str()),
                                    static_cast<DWORD>((command.size() + 1) * sizeof(wchar_t)));
  ::RegCloseKey(key);
  return status == ERROR_SUCCESS;
}

bool StartupEnabled(const EncodableMap& args) {
  HKEY root = RootForScope(StringArg(args, "scope"));
  std::wstring expected = Utf16FromUtf8(StringArg(args, "executable_path"));
  std::wstring value = ReadRegString(root, kRunPath, kRunName);
  return !expected.empty() && value.find(expected) != std::wstring::npos;
}

bool IsAdministrator() {
  BOOL is_member = FALSE;
  SID_IDENTIFIER_AUTHORITY nt_authority = SECURITY_NT_AUTHORITY;
  PSID admin_group = nullptr;
  if (::AllocateAndInitializeSid(&nt_authority, 2, SECURITY_BUILTIN_DOMAIN_RID,
                                 DOMAIN_ALIAS_RID_ADMINS, 0, 0, 0, 0, 0, 0,
                                 &admin_group)) {
    ::CheckTokenMembership(nullptr, admin_group, &is_member);
    ::FreeSid(admin_group);
  }
  return is_member == TRUE;
}

EncodableValue SelectInstallParentDirectory() {
  IFileOpenDialog* dialog = nullptr;
  if (::CoCreateInstance(CLSID_FileOpenDialog, nullptr, CLSCTX_INPROC_SERVER,
                         IID_PPV_ARGS(&dialog)) != S_OK) {
    return EncodableValue();
  }
  DWORD options = 0;
  dialog->GetOptions(&options);
  dialog->SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM);
  if (dialog->Show(nullptr) != S_OK) {
    dialog->Release();
    return EncodableValue();
  }
  IShellItem* item = nullptr;
  if (dialog->GetResult(&item) != S_OK) {
    dialog->Release();
    return EncodableValue();
  }
  PWSTR path = nullptr;
  item->GetDisplayName(SIGDN_FILESYSPATH, &path);
  std::string result = path ? Narrow(path) : "";
  if (path) {
    ::CoTaskMemFree(path);
  }
  item->Release();
  dialog->Release();
  return EncodableValue(result);
}

std::string Sha256File(const std::wstring& path) {
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    return "";
  }
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  DWORD object_length = 0;
  DWORD data_length = 0;
  DWORD hash_length = 0;
  if (::BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) {
    return "";
  }
  ::BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&object_length),
                      sizeof(object_length), &data_length, 0);
  ::BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH, reinterpret_cast<PUCHAR>(&hash_length),
                      sizeof(hash_length), &data_length, 0);
  std::vector<UCHAR> object(object_length);
  std::vector<UCHAR> digest(hash_length);
  if (::BCryptCreateHash(algorithm, &hash, object.data(), object_length, nullptr, 0, 0) != 0) {
    ::BCryptCloseAlgorithmProvider(algorithm, 0);
    return "";
  }
  std::vector<char> buffer(64 * 1024);
  while (file.good()) {
    file.read(buffer.data(), buffer.size());
    std::streamsize read = file.gcount();
    if (read > 0) {
      ::BCryptHashData(hash, reinterpret_cast<PUCHAR>(buffer.data()), static_cast<ULONG>(read), 0);
    }
  }
  ::BCryptFinishHash(hash, digest.data(), hash_length, 0);
  ::BCryptDestroyHash(hash);
  ::BCryptCloseAlgorithmProvider(algorithm, 0);
  std::ostringstream output;
  output << std::hex;
  for (auto byte : digest) {
    output.width(2);
    output.fill('0');
    output << static_cast<int>(byte);
  }
  return output.str();
}

void OpenPath(const EncodableMap& args) {
  std::wstring path = Utf16FromUtf8(StringArg(args, "path"));
  ::ShellExecuteW(nullptr, L"open", path.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

void LaunchProcess(const EncodableMap& args) {
  std::wstring path = Utf16FromUtf8(StringArg(args, "path"));
  auto it = args.find(EncodableValue("arguments"));
  std::wstring parameters;
  if (it != args.end() && std::holds_alternative<std::vector<EncodableValue>>(it->second)) {
    for (const auto& arg : std::get<std::vector<EncodableValue>>(it->second)) {
      if (std::holds_alternative<std::string>(arg)) {
        parameters += L" \"" + Utf16FromUtf8(std::get<std::string>(arg)) + L"\"";
      }
    }
  }
  ::ShellExecuteW(nullptr, L"open", path.c_str(), parameters.empty() ? nullptr : parameters.c_str(),
                  nullptr, SW_SHOWNORMAL);
}

bool CreateDesktopShortcut(const EncodableMap& args) {
  std::wstring executable = Utf16FromUtf8(StringArg(args, "executable_path"));
  std::wstring user_profile = EnvValue(L"USERPROFILE");
  if (executable.empty() || user_profile.empty()) {
    return false;
  }
  std::wstring shortcut_path = user_profile + L"\\Desktop\\Live Dashboard Agent.lnk";
  IShellLinkW* link = nullptr;
  if (::CoCreateInstance(CLSID_ShellLink, nullptr, CLSCTX_INPROC_SERVER,
                         IID_PPV_ARGS(&link)) != S_OK) {
    return false;
  }
  link->SetPath(executable.c_str());
  link->SetWorkingDirectory(ParentPath(executable).c_str());
  link->SetDescription(L"Live Dashboard Agent");
  IPersistFile* file = nullptr;
  bool ok = false;
  if (link->QueryInterface(IID_PPV_ARGS(&file)) == S_OK) {
    ok = file->Save(shortcut_path.c_str(), TRUE) == S_OK;
    file->Release();
  }
  link->Release();
  return ok;
}

const EncodableMap* ArgsMap(const EncodableValue* value) {
  if (!value || !std::holds_alternative<EncodableMap>(*value)) {
    return nullptr;
  }
  return &std::get<EncodableMap>(*value);
}
}  // namespace

void RegisterNativeBridge(flutter::FlutterEngine* engine, FlutterWindow* window) {
  auto channel = std::make_unique<NativeMethodChannel>(
      engine->messenger(), "live_dashboard_agent/windows",
      &flutter::StandardMethodCodec::GetInstance());

  channel->SetMethodCallHandler(
      [window](const MethodCall<EncodableValue>& call,
               std::unique_ptr<MethodResult<EncodableValue>> result) {
        const EncodableMap empty;
        const EncodableMap& args = ArgsMap(call.arguments()) ? *ArgsMap(call.arguments()) : empty;
        const std::string& method = call.method_name();
        if (method == "readConfig") {
          result->Success(ReadConfig());
        } else if (method == "writeConfig") {
          WriteConfig(args);
          result->Success();
        } else if (method == "getPaths") {
          result->Success(GetPaths());
        } else if (method == "probeActivity") {
          result->Success(ProbeActivity());
        } else if (method == "isStartupEnabled") {
          result->Success(EncodableValue(StartupEnabled(args)));
        } else if (method == "setStartupEnabled") {
          result->Success(EncodableValue(SetStartup(args)));
        } else if (method == "isAdministrator") {
          result->Success(EncodableValue(IsAdministrator()));
        } else if (method == "selectInstallParentDirectory") {
          result->Success(SelectInstallParentDirectory());
        } else if (method == "sha256File") {
          result->Success(EncodableValue(Sha256File(Utf16FromUtf8(StringArg(args, "path")))));
        } else if (method == "setHideToTray") {
          if (window) {
            window->SetHideToTray(BoolArg(args, "enabled"));
          }
          result->Success();
        } else if (method == "showMainWindow") {
          if (window) {
            window->ShowAndActivate();
          }
          result->Success();
        } else if (method == "openPath") {
          OpenPath(args);
          result->Success();
        } else if (method == "launchProcess") {
          LaunchProcess(args);
          result->Success();
        } else if (method == "createDesktopShortcut") {
          result->Success(EncodableValue(CreateDesktopShortcut(args)));
        } else {
          result->NotImplemented();
        }
      });
  g_channels.push_back(std::move(channel));
}
