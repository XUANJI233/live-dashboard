using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace LiveDashboardAgent.Services;

public sealed class WindowsActivityProbe
{
    private static readonly IReadOnlyDictionary<string, string> MusicProcessMap =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["spotify.exe"] = "Spotify",
            ["qqmusic.exe"] = "QQ Music",
            ["cloudmusic.exe"] = "NetEase Cloud Music",
            ["foobar2000.exe"] = "foobar2000",
            ["itunes.exe"] = "Apple Music",
            ["applemusic.exe"] = "Apple Music",
            ["kugou.exe"] = "Kugou Music",
            ["kwmusic.exe"] = "Kuwo Music",
            ["aimp.exe"] = "AIMP",
            ["musicbee.exe"] = "MusicBee",
            ["vlc.exe"] = "VLC",
            ["potplayer.exe"] = "PotPlayer",
            ["potplayer64.exe"] = "PotPlayer",
            ["potplayermini.exe"] = "PotPlayer",
            ["potplayermini64.exe"] = "PotPlayer",
            ["wmplayer.exe"] = "Windows Media Player",
        };

    public double GetIdleSeconds()
    {
        try
        {
            var info = new LastInputInfo
            {
                CbSize = (uint)Marshal.SizeOf<LastInputInfo>(),
            };
            if (!GetLastInputInfo(ref info))
            {
                return 0;
            }
            var now = GetTickCount();
            var elapsedMs = unchecked(now - info.DwTime);
            return elapsedMs / 1000.0;
        }
        catch
        {
            return 0;
        }
    }

    public ForegroundWindowSnapshot? GetForegroundWindow()
    {
        try
        {
            var handle = GetForegroundWindowHandle();
            if (handle == IntPtr.Zero)
            {
                return null;
            }

            var title = GetWindowTitle(handle);
            if (string.IsNullOrWhiteSpace(title))
            {
                return null;
            }

            GetWindowThreadProcessId(handle, out var processId);
            var processName = ProcessName(processId);
            return new ForegroundWindowSnapshot(processName, title);
        }
        catch
        {
            return null;
        }
    }

    public bool IsForegroundFullscreen()
    {
        try
        {
            var handle = GetForegroundWindowHandle();
            if (handle == IntPtr.Zero || !GetWindowRect(handle, out var rect))
            {
                return false;
            }

            var width = GetSystemMetrics(SystemMetricScreenWidth);
            var height = GetSystemMetrics(SystemMetricScreenHeight);
            return rect.Left <= 0 &&
                rect.Top <= 0 &&
                rect.Right >= width &&
                rect.Bottom >= height;
        }
        catch
        {
            return false;
        }
    }

    public bool IsAudioPlaying()
    {
        return false;
    }

    public Dictionary<string, object> GetBatteryExtra()
    {
        if (!GetSystemPowerStatus(out var status) || status.BatteryLifePercent > 100)
        {
            return [];
        }

        return new Dictionary<string, object>(StringComparer.Ordinal)
        {
            ["battery_percent"] = (int)status.BatteryLifePercent,
            ["battery_charging"] = (status.AcLineStatus & 1) == 1,
        };
    }

    public MusicSnapshot? GetMusicInfo()
    {
        var results = new List<MusicSnapshot>();
        EnumWindows((handle, lParam) =>
        {
            _ = lParam;
            if (!IsWindowVisible(handle))
            {
                return true;
            }

            var title = GetWindowTitle(handle);
            if (string.IsNullOrWhiteSpace(title))
            {
                return true;
            }

            GetWindowThreadProcessId(handle, out var processId);
            var processName = ProcessName(processId);
            if (!MusicProcessMap.TryGetValue(processName, out var app))
            {
                return true;
            }

            var parsed = ParseMusicTitle(processName, title, app);
            if (parsed is not null)
            {
                results.Add(parsed);
            }
            return true;
        }, IntPtr.Zero);

        return results.FirstOrDefault();
    }

    private static MusicSnapshot? ParseMusicTitle(string processName, string windowTitle, string app)
    {
        if (string.Equals(processName, "spotify.exe", StringComparison.OrdinalIgnoreCase))
        {
            if (windowTitle is "Spotify" or "Spotify Free" or "Spotify Premium")
            {
                return null;
            }
            if (windowTitle.Contains(" - ", StringComparison.Ordinal))
            {
                var parts = windowTitle.Split(" - ", 2, StringSplitOptions.TrimEntries);
                return new MusicSnapshot(app, parts.ElementAtOrDefault(1) ?? "", parts.ElementAtOrDefault(0) ?? "");
            }
            return new MusicSnapshot(app, windowTitle, "");
        }

        if (string.Equals(processName, "foobar2000.exe", StringComparison.OrdinalIgnoreCase))
        {
            var cleaned = RemoveTrailingFoobarSuffix(windowTitle);
            if (cleaned.Contains(" - ", StringComparison.Ordinal))
            {
                var parts = cleaned.Split(" - ", 2, StringSplitOptions.TrimEntries);
                return new MusicSnapshot(app, parts.ElementAtOrDefault(1) ?? "", parts.ElementAtOrDefault(0) ?? "");
            }
            return string.IsNullOrWhiteSpace(cleaned) ? null : new MusicSnapshot(app, cleaned, "");
        }

        if (string.Equals(windowTitle, app, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        if (windowTitle.Contains(" - ", StringComparison.Ordinal))
        {
            var parts = windowTitle.Split(" - ", 2, StringSplitOptions.TrimEntries);
            return new MusicSnapshot(app, parts.ElementAtOrDefault(0) ?? "", parts.ElementAtOrDefault(1) ?? "");
        }
        return new MusicSnapshot(app, windowTitle, "");
    }

    private static string RemoveTrailingFoobarSuffix(string value)
    {
        const string marker = "[foobar2000";
        var index = value.LastIndexOf(marker, StringComparison.OrdinalIgnoreCase);
        return index < 0 ? value.Trim() : value[..index].Trim();
    }

    private static string GetWindowTitle(IntPtr handle)
    {
        var length = GetWindowTextLength(handle);
        if (length <= 0)
        {
            return "";
        }

        var buffer = new StringBuilder(length + 1);
        return GetWindowText(handle, buffer, buffer.Capacity) > 0
            ? buffer.ToString().Trim()
            : "";
    }

    private static string ProcessName(uint processId)
    {
        try
        {
            using var process = Process.GetProcessById((int)processId);
            return process.ProcessName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? process.ProcessName
                : process.ProcessName + ".exe";
        }
        catch
        {
            return "unknown";
        }
    }

    private const int SystemMetricScreenWidth = 0;
    private const int SystemMetricScreenHeight = 1;

    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll", EntryPoint = "GetForegroundWindow")]
    private static extern IntPtr GetForegroundWindowHandle();

    [DllImport("user32.dll", EntryPoint = "GetWindowTextW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll", EntryPoint = "GetWindowTextLengthW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowRect(IntPtr hWnd, out Rect lpRect);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool GetLastInputInfo(ref LastInputInfo plii);

    [DllImport("kernel32.dll")]
    private static extern uint GetTickCount();

    [DllImport("kernel32.dll")]
    private static extern bool GetSystemPowerStatus(out SystemPowerStatus lpSystemPowerStatus);

    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo
    {
        public uint CbSize;
        public uint DwTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SystemPowerStatus
    {
        public byte AcLineStatus;
        public byte BatteryFlag;
        public byte BatteryLifePercent;
        public byte SystemStatusFlag;
        public int BatteryLifeTime;
        public int BatteryFullLifeTime;
    }
}
