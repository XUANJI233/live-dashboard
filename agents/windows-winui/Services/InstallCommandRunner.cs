using System.Text.Json;

namespace LiveDashboardAgent.Services;

public static class InstallCommandRunner
{
    public static bool TryRun(string[] args)
    {
        if (!InstallCommandOptions.TryParse(args, out var command) || command is null)
        {
            return false;
        }

        var result = RequiresElevation(command)
            ? new ElevatedInstallLauncher().Run(command).GetAwaiter().GetResult()
            : Execute(command);
        if (!string.IsNullOrWhiteSpace(command.ResultPath))
        {
            WriteResult(command.ResultPath, result);
        }
        return true;
    }

    private static InstallResult Execute(InstallCommandOptions command)
    {
        var service = new UserInstallService();
        try
        {
            return command.Action switch
            {
                InstallAction.Install => service.Install(
                    new InstallOptions(
                        command.Scope,
                        command.InstallDirectory,
                        command.CreateDesktopShortcut)),
                InstallAction.Uninstall => service.Uninstall(
                    new UninstallOptions(
                        command.Scope,
                        command.InstallDirectory,
                        command.ParentProcessId,
                        command.RemoveLogs)),
                _ => new InstallResult(false, false, "未知安装动作。", command.InstallDirectory),
            };
        }
        catch (Exception ex)
        {
            return new InstallResult(false, false, ex.Message, command.InstallDirectory);
        }
    }

    private static void WriteResult(string path, InstallResult result)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var json = JsonSerializer.Serialize(result);
        File.WriteAllText(path, json);
    }

    private static bool RequiresElevation(InstallCommandOptions command)
    {
        return command.Scope == InstallScope.AllUsers && !ProcessElevation.IsAdministrator();
    }
}
