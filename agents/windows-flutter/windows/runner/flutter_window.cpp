#include "flutter_window.h"

#include <optional>
#include <shellapi.h>

#include "flutter/generated_plugin_registrant.h"
#include "native_bridge.h"
#include "resource.h"

namespace {
constexpr UINT kTrayIconId = 1;
constexpr UINT kTrayMessage = WM_APP + 42;
constexpr UINT kTrayOpenCommand = 1001;
constexpr UINT kTrayExitCommand = 1003;
}  // namespace

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {
  RemoveTrayIcon();
}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  RegisterNativeBridge(flutter_controller_->engine(), this);
  SetChildContent(flutter_controller_->view()->GetNativeWindow());
  EnsureTrayIcon();

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  RemoveTrayIcon();
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_CLOSE:
      if (hide_to_tray_) {
        ::ShowWindow(hwnd, SW_HIDE);
        return 0;
      }
      break;
    case kTrayMessage:
      if (lparam == WM_LBUTTONDBLCLK || lparam == WM_LBUTTONUP) {
        ShowAndActivate();
        return 0;
      }
      if (lparam == WM_RBUTTONUP || lparam == WM_CONTEXTMENU) {
        ShowTrayMenu();
        return 0;
      }
      break;
    case WM_COMMAND:
      switch (LOWORD(wparam)) {
        case kTrayOpenCommand:
          ShowAndActivate();
          return 0;
        case kTrayExitCommand:
          ExitApplication();
          return 0;
      }
      break;
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}

void FlutterWindow::ShowTrayMenu() {
  HWND handle = GetHandle();
  if (!handle) {
    return;
  }
  HMENU menu = ::CreatePopupMenu();
  if (!menu) {
    return;
  }
  ::AppendMenuW(menu, MF_STRING, kTrayOpenCommand, L"Open");
  ::AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  ::AppendMenuW(menu, MF_STRING, kTrayExitCommand, L"Exit");
  POINT point{};
  ::GetCursorPos(&point);
  ::SetForegroundWindow(handle);
  ::TrackPopupMenu(menu, TPM_RIGHTBUTTON, point.x, point.y, 0, handle, nullptr);
  ::DestroyMenu(menu);
}

void FlutterWindow::ExitApplication() {
  hide_to_tray_ = false;
  RemoveTrayIcon();
  HWND handle = GetHandle();
  if (handle) {
    ::DestroyWindow(handle);
  } else {
    ::PostQuitMessage(0);
  }
}

void FlutterWindow::SetHideToTray(bool enabled) {
  hide_to_tray_ = enabled;
  if (enabled) {
    EnsureTrayIcon();
  } else {
    RemoveTrayIcon();
  }
}

void FlutterWindow::ShowAndActivate() {
  HWND handle = GetHandle();
  if (!handle) {
    return;
  }
  ::ShowWindow(handle, SW_RESTORE);
  ::ShowWindow(handle, SW_SHOW);
  ::SetForegroundWindow(handle);
}

void FlutterWindow::EnsureTrayIcon() {
  if (tray_created_ || !GetHandle()) {
    return;
  }
  NOTIFYICONDATAW data{};
  data.cbSize = sizeof(data);
  data.hWnd = GetHandle();
  data.uID = kTrayIconId;
  data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
  data.uCallbackMessage = kTrayMessage;
  data.hIcon = ::LoadIcon(::GetModuleHandle(nullptr), MAKEINTRESOURCE(IDI_APP_ICON));
  wcscpy_s(data.szTip, L"Live Dashboard Agent");
  tray_created_ = ::Shell_NotifyIconW(NIM_ADD, &data) == TRUE;
}

void FlutterWindow::RemoveTrayIcon() {
  if (!tray_created_ || !GetHandle()) {
    return;
  }
  NOTIFYICONDATAW data{};
  data.cbSize = sizeof(data);
  data.hWnd = GetHandle();
  data.uID = kTrayIconId;
  ::Shell_NotifyIconW(NIM_DELETE, &data);
  tray_created_ = false;
}
