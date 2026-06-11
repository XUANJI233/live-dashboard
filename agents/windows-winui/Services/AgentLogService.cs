using System.Diagnostics;

namespace LiveDashboardAgent.Services;

public static class AgentLogService
{
    private const long MaxLogBytes = 1024 * 1024;

    public static string LogDirectory => Path.Combine(AppContext.BaseDirectory, "logs");

    public static string LogPath => Path.Combine(LogDirectory, "agent.log");

    public static void Write(AppConfig config, string message)
    {
        if (!config.EnableLog)
        {
            return;
        }

        try
        {
            Directory.CreateDirectory(LogDirectory);
            RotateIfNeeded();
            File.AppendAllText(LogPath, $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
        }
        catch
        {
            // Logging must never affect the resident agent loop.
        }
    }

    public static void OpenLogFile()
    {
        Directory.CreateDirectory(LogDirectory);
        if (!File.Exists(LogPath))
        {
            File.WriteAllText(LogPath, "");
        }

        Process.Start(new ProcessStartInfo
        {
            FileName = LogPath,
            UseShellExecute = true,
        });
    }

    public static void OpenLogFolder()
    {
        Directory.CreateDirectory(LogDirectory);
        Process.Start(new ProcessStartInfo
        {
            FileName = LogDirectory,
            UseShellExecute = true,
        });
    }

    private static void RotateIfNeeded()
    {
        var file = new FileInfo(LogPath);
        if (!file.Exists || file.Length <= MaxLogBytes)
        {
            return;
        }

        var rotated = Path.Combine(
            file.DirectoryName!,
            "agent.log." + DateTimeOffset.Now.ToString("yyyyMMddHHmmss"));
        File.Move(LogPath, rotated, overwrite: true);
    }
}
