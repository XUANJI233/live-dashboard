using System.Runtime.InteropServices;
using Microsoft.UI.Xaml;
using WinRT.Interop;

namespace LiveDashboardAgent.Services;

public static class WindowActivation
{
    private const int ShowHide = 0;
    private const int ShowNormal = 1;
    private const int ShowRestore = 9;

    public static void BringToFront(Window window)
    {
        ShowAndActivate(window);
    }

    public static void ShowAndActivate(Window window)
    {
        window.AppWindow.Show();
        var handle = WindowNative.GetWindowHandle(window);
        if (handle != IntPtr.Zero)
        {
            ShowWindow(handle, ShowNormal);
            ShowWindow(handle, ShowRestore);
            SetForegroundWindow(handle);
        }
        window.Activate();
    }

    public static void Hide(Window window)
    {
        window.AppWindow.Hide();
        var handle = WindowNative.GetWindowHandle(window);
        if (handle != IntPtr.Zero)
        {
            ShowWindow(handle, ShowHide);
        }
    }

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
}
