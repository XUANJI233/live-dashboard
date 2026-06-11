namespace LiveDashboardAgent.Services;

public sealed class UserInstallService
{
    public string DefaultDirectory(InstallScope scope)
    {
        return InstallationMode.DefaultInstallDirectoryFor(scope);
    }

    public bool RequiresElevation(InstallScope scope)
    {
        return scope == InstallScope.AllUsers && !ProcessElevation.IsAdministrator();
    }

    public bool IsRunningFromDirectory(string installDirectory)
    {
        return InstallExecutableResolver.IsRunningFromDirectory(installDirectory);
    }

    public bool IsStartupEnabled(InstallScope scope, string installDirectory)
    {
        if (!InstallDirectorySafety.TryNormalizeDirectory(installDirectory, out _, out _))
        {
            return false;
        }
        var executable = InstallExecutableResolver.ResolveStartupExecutable(installDirectory);
        return new StartupManager(executable, scope).IsEnabled();
    }

    public bool ShouldShowInstallerOnLaunch()
    {
        return InstallationMode.Current == AgentDistributionMode.UserInstall &&
            !IsRunningFromRegisteredInstall();
    }

    public bool IsRunningFromRegisteredInstall()
    {
        return GetRunningInstall() is not null;
    }

    public InstallRegistration? GetRunningInstall()
    {
        return InstallRegistrationResolver.GetRunningInstall();
    }

    public InstallResult Install(InstallOptions options)
    {
        if (!InstallDirectorySafety.TryNormalizeDirectory(options.InstallDirectory, out var target, out var pathError))
        {
            return new InstallResult(false, false, pathError!, options.InstallDirectory);
        }
        if (InstallationMode.Current != AgentDistributionMode.UserInstall)
        {
            return new InstallResult(false, false, "便携版不执行安装，请使用安装版。", target);
        }
        if (RequiresElevation(options.Scope))
        {
            return new InstallResult(
                false,
                false,
                "所有用户安装需要管理员权限。",
                target,
                RequiresElevation: true);
        }

        var validationError = InstallDirectorySafety.ValidateInstallTarget(target);
        if (validationError is not null)
        {
            return new InstallResult(false, false, validationError, target);
        }

        try
        {
            var source = InstallDirectorySafety.NormalizeDirectory(AppContext.BaseDirectory);
            if (string.Equals(source, target, StringComparison.OrdinalIgnoreCase) ||
                InstallDirectorySafety.IsChildDirectory(source, target) ||
                InstallDirectorySafety.IsChildDirectory(target, source))
            {
                return new InstallResult(false, false, "安装路径不能是当前安装器目录、父目录或子目录。", target);
            }

            Directory.CreateDirectory(target);
            var installedFiles = InstallFileCopier.CopyDirectory(source, target);

            InstallDirectorySafety.WriteInstallMarker(target, options.Scope);
            InstallManifestStore.Write(
                target,
                options.Scope,
                installedFiles.Append(InstallDirectorySafety.MarkerFileName));
            var summary = InstallManifestStore.ReadSummary(target);
            if (summary is null)
            {
                return new InstallResult(false, false, "安装清单写入失败。", target);
            }
            var targetExe = Path.Combine(target, InstallExecutableResolver.InstalledExecutableName);
            if (!File.Exists(targetExe))
            {
                return new InstallResult(false, false, "安装目录缺少主程序。", target);
            }

            InstallRegistryStore.Save(options.Scope, summary);
            UninstallRegistryStore.Save(options.Scope, targetExe, target);

            var startupResult = new StartupManager(targetExe, options.Scope).SetEnabled(true);
            var shortcutResult = options.CreateDesktopShortcut
                ? DesktopShortcutManager.Create(options.Scope, targetExe)
                : new DesktopShortcutResult(false, true, "未创建桌面快捷方式。");
            var scope = InstallationMode.LabelFor(options.Scope);
            var ok = startupResult.Ok && shortcutResult.Ok;
            var message = InstallResultMessages.BuildInstallMessage(
                scope,
                startupResult,
                shortcutResult,
                options.CreateDesktopShortcut);
            return new InstallResult(true, ok, message, target);
        }
        catch (Exception ex)
        {
            return new InstallResult(false, false, ex.Message, target);
        }
    }

    public InstallResult Uninstall(UninstallOptions options)
    {
        if (!InstallDirectorySafety.TryNormalizeDirectory(options.InstallDirectory, out var target, out var pathError))
        {
            return new InstallResult(false, false, pathError!, options.InstallDirectory);
        }
        if (RequiresElevation(options.Scope))
        {
            return new InstallResult(
                false,
                false,
                "所有用户卸载需要管理员权限。",
                target,
                RequiresElevation: true);
        }

        try
        {
            var executable = InstallExecutableResolver.ResolveStartupExecutable(target);
            var startupResult = new StartupManager(executable, options.Scope).SetEnabled(false);
            if (!Directory.Exists(target))
            {
                var shortcutResult = DesktopShortcutManager.Remove(options.Scope, executable);
                InstallRegistryStore.Clear(options.Scope);
                UninstallRegistryStore.Clear(options.Scope);
                return new InstallResult(
                    startupResult.Enabled || shortcutResult.Changed,
                    startupResult.Ok && shortcutResult.Ok,
                    InstallResultMessages.BuildMissingDirectoryUninstallMessage(shortcutResult),
                    target);
            }

            var deleteValidation = InstallDirectorySafety.ValidateRemovalTarget(options.Scope, target);
            deleteValidation ??= InstallManifestStore.ValidateRegistrySummary(
                options.Scope,
                target,
                InstallRegistryStore.Load(options.Scope));
            if (deleteValidation is not null)
            {
                return new InstallResult(
                    startupResult.Enabled,
                    false,
                    deleteValidation,
                    target);
            }

            if (IsRunningFromDirectory(target))
            {
                var shortcutResult = DesktopShortcutManager.Remove(options.Scope, executable);
                UninstallRegistryStore.Clear(options.Scope);
                DeferredUninstallScheduler.Schedule(
                    target,
                    options.Scope,
                    options.ParentProcessId,
                    options.RemoveLogs);
                return new InstallResult(
                    true,
                    startupResult.Ok && shortcutResult.Ok,
                    InstallResultMessages.BuildPendingUninstallMessage(shortcutResult),
                    target,
                    PendingDirectoryRemoval: true);
            }

            var removal = InstallManifestStore.RemoveInstalledFiles(options.Scope, target);
            var shortcutRemoval = removal.Ok
                ? DesktopShortcutManager.Remove(options.Scope, executable)
                : new DesktopShortcutResult(false, true, "未删除桌面快捷方式。");
            var logs = options.RemoveLogs
                ? InstallRuntimeArtifacts.RemoveLogs(target)
                : new RuntimeArtifactCleanupResult(0, 0);
            if (removal.Ok)
            {
                InstallRegistryStore.Clear(options.Scope);
                UninstallRegistryStore.Clear(options.Scope);
            }
            var ok = startupResult.Ok && removal.Ok && logs.SkippedLogs == 0 && shortcutRemoval.Ok;
            var message = InstallResultMessages.BuildUninstallMessage(
                removal,
                logs,
                shortcutRemoval,
                options.RemoveLogs,
                startupResult.Message);
            return new InstallResult(
                removal.Changed || logs.DeletedLogs > 0 || shortcutRemoval.Changed,
                ok,
                message,
                target);
        }
        catch (Exception ex)
        {
            return new InstallResult(false, false, ex.Message, target);
        }
    }

}
