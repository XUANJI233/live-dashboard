namespace LiveDashboardAgent.Services;

internal static class InstallRegistrationResolver
{
    public static InstallRegistration? GetRunningInstall()
    {
        return GetRunningInstall(InstallScope.CurrentUser) ??
            GetRunningInstall(InstallScope.AllUsers);
    }

    private static InstallRegistration? GetRunningInstall(InstallScope scope)
    {
        var record = InstallRegistryStore.Load(scope);
        if (record is null)
        {
            return null;
        }

        var validation = InstallManifestStore.ValidateRegistrySummary(
            scope,
            record.InstallDirectory,
            record);
        if (validation is not null)
        {
            return null;
        }

        var current = InstallDirectorySafety.NormalizeDirectory(AppContext.BaseDirectory);
        var install = InstallDirectorySafety.NormalizeDirectory(record.InstallDirectory);
        return string.Equals(current, install, StringComparison.OrdinalIgnoreCase)
            ? new InstallRegistration(scope, install)
            : null;
    }
}
