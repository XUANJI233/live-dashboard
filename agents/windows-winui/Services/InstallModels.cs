namespace LiveDashboardAgent.Services;

public enum InstallScope
{
    CurrentUser,
    AllUsers,
}

public enum InstallAction
{
    Install,
    Uninstall,
}

public sealed record InstallRegistration(
    InstallScope Scope,
    string InstallDirectory);

public sealed record InstallOptions(
    InstallScope Scope,
    string InstallDirectory,
    bool CreateDesktopShortcut = false);

public sealed record InstallResult(
    bool Changed,
    bool Ok,
    string Message,
    string InstallDirectory,
    bool RequiresElevation = false,
    bool PendingDirectoryRemoval = false);

public sealed record UninstallOptions(
    InstallScope Scope,
    string InstallDirectory,
    int? ParentProcessId = null,
    bool RemoveLogs = false);
