using System.Runtime.InteropServices;

namespace LiveDashboardAgent.Services;

public sealed class TrayIconService : IDisposable
{
    private const uint TrayIconId = 1;
    private const uint TrayCallbackMessage = 0x8000 + 0x4DA;
    private const uint OpenMenuId = 1001;
    private const uint SettingsMenuId = 1002;
    private const uint ExitMenuId = 1003;

    private readonly IntPtr _windowHandle;
    private readonly Action _openMainWindow;
    private readonly Action _openSettings;
    private readonly Action _exitApplication;
    private readonly IDisposable _messageRegistration;
    private readonly IntPtr _iconHandle;
    private readonly bool _ownsIcon;
    private bool _disposed;

    public TrayIconService(
        WindowMessageRouter messageRouter,
        Action openMainWindow,
        Action openSettings,
        Action exitApplication)
    {
        _windowHandle = messageRouter.WindowHandle;
        _openMainWindow = openMainWindow;
        _openSettings = openSettings;
        _exitApplication = exitApplication;
        (_iconHandle, _ownsIcon) = LoadTrayIcon();

        _messageRegistration = messageRouter.Register(HandleWindowMessage);
        AddIcon();
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        DeleteIcon();
        _messageRegistration.Dispose();
        if (_ownsIcon && _iconHandle != IntPtr.Zero)
        {
            DestroyIcon(_iconHandle);
        }
    }

    private bool HandleWindowMessage(
        uint message,
        IntPtr wParam,
        IntPtr lParam,
        out IntPtr result)
    {
        result = IntPtr.Zero;
        if (message == TrayCallbackMessage && wParam.ToInt64() == TrayIconId)
        {
            HandleTrayMessage((uint)lParam.ToInt64());
            return true;
        }

        return false;
    }

    private void HandleTrayMessage(uint message)
    {
        switch (message)
        {
            case NativeMethods.WmLeftButtonDoubleClick:
                _openMainWindow();
                break;
            case NativeMethods.WmRightButtonUp:
            case NativeMethods.WmContextMenu:
                ShowContextMenu();
                break;
        }
    }

    private void ShowContextMenu()
    {
        var menu = CreatePopupMenu();
        if (menu == IntPtr.Zero)
        {
            return;
        }

        try
        {
            AppendMenu(menu, NativeMethods.MfString, OpenMenuId, "打开主界面");
            AppendMenu(menu, NativeMethods.MfString, SettingsMenuId, "设置");
            AppendMenu(menu, NativeMethods.MfSeparator, 0, null);
            AppendMenu(menu, NativeMethods.MfString, ExitMenuId, "退出");
            GetCursorPos(out var point);
            SetForegroundWindow(_windowHandle);
            var command = TrackPopupMenu(
                menu,
                NativeMethods.TpmReturnCommand | NativeMethods.TpmRightButton,
                point.X,
                point.Y,
                0,
                _windowHandle,
                IntPtr.Zero);
            RunMenuCommand(command);
        }
        finally
        {
            DestroyMenu(menu);
        }
    }

    private void RunMenuCommand(uint command)
    {
        switch (command)
        {
            case OpenMenuId:
                _openMainWindow();
                break;
            case SettingsMenuId:
                _openSettings();
                break;
            case ExitMenuId:
                _exitApplication();
                break;
        }
    }

    private void AddIcon()
    {
        var data = CreateIconData();
        Shell_NotifyIcon(NativeMethods.NimAdd, ref data);
        data.VersionOrTimeout = NativeMethods.NotifyIconVersion4;
        Shell_NotifyIcon(NativeMethods.NimSetVersion, ref data);
    }

    private void DeleteIcon()
    {
        var data = CreateIconData();
        Shell_NotifyIcon(NativeMethods.NimDelete, ref data);
    }

    private NotifyIconData CreateIconData()
    {
        return new NotifyIconData
        {
            Size = (uint)Marshal.SizeOf<NotifyIconData>(),
            WindowHandle = _windowHandle,
            Id = TrayIconId,
            Flags = NativeMethods.NifMessage | NativeMethods.NifIcon | NativeMethods.NifTip,
            CallbackMessage = TrayCallbackMessage,
            IconHandle = _iconHandle,
            Tip = "Live Dashboard",
            Info = "",
            InfoTitle = "",
        };
    }

    private static (IntPtr Handle, bool OwnsHandle) LoadTrayIcon()
    {
        var path = AppIconPath.Resolve();
        if (File.Exists(path))
        {
            var loaded = LoadImage(
                IntPtr.Zero,
                path,
                NativeMethods.ImageIcon,
                0,
                0,
                NativeMethods.LrLoadFromFile | NativeMethods.LrDefaultSize);
            if (loaded != IntPtr.Zero)
            {
                return (loaded, true);
            }
        }

        return (LoadIcon(IntPtr.Zero, NativeMethods.IdiApplication), false);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyIconData
    {
        public uint Size;
        public IntPtr WindowHandle;
        public uint Id;
        public uint Flags;
        public uint CallbackMessage;
        public IntPtr IconHandle;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string Tip;

        public uint State;
        public uint StateMask;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string Info;

        public uint VersionOrTimeout;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string InfoTitle;

        public uint InfoFlags;
        public Guid GuidItem;
        public IntPtr BalloonIconHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    private static class NativeMethods
    {
        public const uint NimAdd = 0x00000000;
        public const uint NimDelete = 0x00000002;
        public const uint NimSetVersion = 0x00000004;
        public const uint NifMessage = 0x00000001;
        public const uint NifIcon = 0x00000002;
        public const uint NifTip = 0x00000004;
        public const uint NotifyIconVersion4 = 4;

        public const uint WmContextMenu = 0x007B;
        public const uint WmLeftButtonDoubleClick = 0x0203;
        public const uint WmRightButtonUp = 0x0205;

        public const uint MfString = 0x00000000;
        public const uint MfSeparator = 0x00000800;
        public const uint TpmRightButton = 0x00000002;
        public const uint TpmReturnCommand = 0x00000100;

        public const uint ImageIcon = 1;
        public const uint LrLoadFromFile = 0x00000010;
        public const uint LrDefaultSize = 0x00000040;
        public static readonly IntPtr IdiApplication = new(32512);
    }

    [DllImport("shell32.dll", EntryPoint = "Shell_NotifyIconW", SetLastError = true)]
    private static extern bool Shell_NotifyIcon(uint message, ref NotifyIconData data);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CreatePopupMenu();

    [DllImport("user32.dll", EntryPoint = "AppendMenuW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool AppendMenu(IntPtr menu, uint flags, uint itemId, string? newItem);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyMenu(IntPtr menu);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetCursorPos(out Point point);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint TrackPopupMenu(
        IntPtr menu,
        uint flags,
        int x,
        int y,
        int reserved,
        IntPtr hwnd,
        IntPtr rect);

    [DllImport("user32.dll", EntryPoint = "LoadImageW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr LoadImage(
        IntPtr instance,
        string imageName,
        uint type,
        int desiredWidth,
        int desiredHeight,
        uint load);

    [DllImport("user32.dll", EntryPoint = "LoadIconW", SetLastError = true)]
    private static extern IntPtr LoadIcon(IntPtr instance, IntPtr iconName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool DestroyIcon(IntPtr icon);
}
