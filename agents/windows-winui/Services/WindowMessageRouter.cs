using System.Runtime.InteropServices;

namespace LiveDashboardAgent.Services;

public sealed class WindowMessageRouter : IDisposable
{
    private const int GwlpWndProc = -4;

    private readonly List<WindowMessageHandler> _handlers = [];
    private readonly WndProc _wndProc;
    private readonly IntPtr _wndProcPointer;
    private readonly IntPtr _previousWndProc;
    private bool _disposed;

    public WindowMessageRouter(IntPtr windowHandle)
    {
        if (windowHandle == IntPtr.Zero)
        {
            throw new ArgumentException("Window handle is required.", nameof(windowHandle));
        }

        WindowHandle = windowHandle;
        _wndProc = HandleMessage;
        _wndProcPointer = Marshal.GetFunctionPointerForDelegate(_wndProc);
        Marshal.SetLastPInvokeError(0);
        _previousWndProc = SetWindowLongPtr(WindowHandle, GwlpWndProc, _wndProcPointer);
        if (_previousWndProc == IntPtr.Zero && Marshal.GetLastPInvokeError() != 0)
        {
            throw new InvalidOperationException("Unable to install window message router.");
        }
    }

    public IntPtr WindowHandle { get; }

    public IDisposable Register(WindowMessageHandler handler)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        lock (_handlers)
        {
            _handlers.Add(handler);
        }

        return new HandlerRegistration(this, handler);
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        SetWindowLongPtr(WindowHandle, GwlpWndProc, _previousWndProc);
        lock (_handlers)
        {
            _handlers.Clear();
        }
    }

    private IntPtr HandleMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam)
    {
        WindowMessageHandler[] handlers;
        lock (_handlers)
        {
            handlers = _handlers.ToArray();
        }

        foreach (var handler in handlers)
        {
            if (handler(message, wParam, lParam, out var result))
            {
                return result;
            }
        }

        return CallWindowProc(_previousWndProc, hwnd, message, wParam, lParam);
    }

    private void Unregister(WindowMessageHandler handler)
    {
        lock (_handlers)
        {
            _handlers.Remove(handler);
        }
    }

    private static IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value)
    {
        if (IntPtr.Size == 8)
        {
            return SetWindowLongPtr64(hwnd, index, value);
        }

        return new IntPtr(SetWindowLong32(hwnd, index, value.ToInt32()));
    }

    private sealed class HandlerRegistration(
        WindowMessageRouter router,
        WindowMessageHandler handler) : IDisposable
    {
        private bool _disposed;

        public void Dispose()
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            router.Unregister(handler);
        }
    }

    private delegate IntPtr WndProc(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
    private static extern IntPtr SetWindowLongPtr64(IntPtr hwnd, int index, IntPtr value);

    [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
    private static extern int SetWindowLong32(IntPtr hwnd, int index, int value);

    [DllImport("user32.dll", EntryPoint = "CallWindowProcW")]
    private static extern IntPtr CallWindowProc(
        IntPtr previousWndProc,
        IntPtr hwnd,
        uint message,
        IntPtr wParam,
        IntPtr lParam);
}

public delegate bool WindowMessageHandler(
    uint message,
    IntPtr wParam,
    IntPtr lParam,
    out IntPtr result);
