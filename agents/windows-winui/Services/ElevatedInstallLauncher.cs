using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;

namespace LiveDashboardAgent.Services;

public sealed class ElevatedInstallLauncher
{
    private static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(5);

    public async Task<InstallResult> Run(InstallCommandOptions command)
    {
        var resultPath = Path.Combine(
            Path.GetTempPath(),
            $"live-dashboard-agent-install-{Guid.NewGuid():N}.json");
        var commandWithResult = command with { ResultPath = resultPath };

        try
        {
            using var process = StartElevated(commandWithResult);
            if (process is null)
            {
                return new InstallResult(false, false, "无法启动管理员权限 helper。", command.InstallDirectory);
            }

            using var timeout = new CancellationTokenSource(DefaultTimeout);
            await process.WaitForExitAsync(timeout.Token);
            return ReadResult(resultPath, command.InstallDirectory);
        }
        catch (OperationCanceledException)
        {
            return new InstallResult(false, false, "管理员权限操作超时。", command.InstallDirectory);
        }
        catch (Win32Exception ex) when ((uint)ex.NativeErrorCode == 1223)
        {
            return new InstallResult(false, false, "已取消管理员权限请求。", command.InstallDirectory);
        }
        catch (Exception ex)
        {
            return new InstallResult(false, false, ex.Message, command.InstallDirectory);
        }
        finally
        {
            TryDelete(resultPath);
        }
    }

    private static Process? StartElevated(InstallCommandOptions command)
    {
        var executable = CurrentExecutablePath();
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = true,
            Verb = "runas",
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        foreach (var argument in command.ToArguments())
        {
            startInfo.ArgumentList.Add(argument);
        }
        return Process.Start(startInfo);
    }

    private static InstallResult ReadResult(string path, string fallbackDirectory)
    {
        if (!File.Exists(path))
        {
            return new InstallResult(false, false, "管理员权限 helper 未返回结果。", fallbackDirectory);
        }

        var result = JsonSerializer.Deserialize<InstallResult>(File.ReadAllText(path));
        return result ?? new InstallResult(false, false, "管理员权限 helper 返回了空结果。", fallbackDirectory);
    }

    private static string CurrentExecutablePath()
    {
        return Environment.ProcessPath ??
            Process.GetCurrentProcess().MainModule?.FileName ??
            throw new InvalidOperationException("无法确定当前程序路径。");
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch
        {
            // Temporary helper result cleanup is best effort.
        }
    }
}
