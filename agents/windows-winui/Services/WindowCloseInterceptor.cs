namespace LiveDashboardAgent.Services;

public sealed class WindowCloseInterceptor : IDisposable
{
    private const uint WmClose = 0x0010;
    private const uint WmSysCommand = 0x0112;
    private const int ScClose = 0xF060;

    private readonly Func<bool> _shouldHide;
    private readonly Action _hideWindow;
    private readonly IDisposable _registration;

    public WindowCloseInterceptor(WindowMessageRouter router, Func<bool> shouldHide, Action hideWindow)
    {
        _shouldHide = shouldHide;
        _hideWindow = hideWindow;
        _registration = router.Register(HandleMessage);
    }

    public void Dispose()
    {
        _registration.Dispose();
    }

    private bool HandleMessage(uint message, IntPtr wParam, IntPtr lParam, out IntPtr result)
    {
        result = IntPtr.Zero;
        var isCloseMessage = message == WmClose ||
            (message == WmSysCommand && ((int)wParam & 0xFFF0) == ScClose);
        if (!isCloseMessage || !_shouldHide())
        {
            return false;
        }

        _hideWindow();
        return true;
    }
}
