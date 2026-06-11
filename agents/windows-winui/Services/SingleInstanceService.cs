using System.Runtime.InteropServices;

namespace LiveDashboardAgent.Services;

public sealed class SingleInstanceService : IDisposable
{
    private const string MutexName = @"Local\LiveDashboardAgentWinUISingleton";
    private const string ActivationEventName = @"Local\LiveDashboardAgentWinUIOpen";
    private const uint EventModifyState = 0x0002;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 0x102;

    private readonly Mutex _mutex;
    private readonly IntPtr _eventHandle;
    private readonly CancellationTokenSource _activationStop = new();
    private Task? _activationTask;

    public SingleInstanceService()
    {
        _mutex = new Mutex(false, MutexName, out var createdNew);
        AlreadyRunning = !createdNew;
        _eventHandle = AlreadyRunning ? IntPtr.Zero : CreateEvent(IntPtr.Zero, false, false, ActivationEventName);
    }

    public bool AlreadyRunning { get; }

    public bool NotifyExisting(int attempts = 8)
    {
        for (var attempt = 0; attempt < Math.Max(1, attempts); attempt++)
        {
            var handle = OpenEvent(EventModifyState, false, ActivationEventName);
            if (handle != IntPtr.Zero)
            {
                try
                {
                    return SetEvent(handle);
                }
                finally
                {
                    CloseHandle(handle);
                }
            }
            Thread.Sleep(150);
        }
        return false;
    }

    public void StartActivationListener(Action callback)
    {
        if (AlreadyRunning || _eventHandle == IntPtr.Zero || _activationTask is not null)
        {
            return;
        }

        _activationTask = Task.Run(() =>
        {
            while (!_activationStop.IsCancellationRequested)
            {
                var result = WaitForSingleObject(_eventHandle, 1000);
                if (result == WaitObject0)
                {
                    callback();
                }
                else if (result != WaitTimeout)
                {
                    Thread.Sleep(1000);
                }
            }
        });
    }

    public void Dispose()
    {
        _activationStop.Cancel();
        try
        {
            _activationTask?.Wait(TimeSpan.FromSeconds(2));
        }
        catch
        {
            // Shutdown should never hang on the activation listener.
        }
        _activationStop.Dispose();
        if (_eventHandle != IntPtr.Zero)
        {
            CloseHandle(_eventHandle);
        }
        _mutex.Dispose();
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateEventW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateEvent(IntPtr lpEventAttributes, bool bManualReset, bool bInitialState, string lpName);

    [DllImport("kernel32.dll", EntryPoint = "OpenEventW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr OpenEvent(uint dwDesiredAccess, bool bInheritHandle, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetEvent(IntPtr hEvent);

    [DllImport("kernel32.dll")]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr hObject);
}
