using System.Diagnostics;

namespace LiveDashboardAgent.Services;

internal static class DeferredUninstallScheduler
{
    public static void Schedule(
        string target,
        InstallScope scope,
        int? parentProcessId,
        bool removeLogs)
    {
        var waitPids = new[] { parentProcessId, Environment.ProcessId }
            .Where(pid => pid is > 0)
            .Select(pid => pid!.Value)
            .Distinct()
            .ToArray();
        var scriptPath = Path.Combine(
            Path.GetTempPath(),
            $"live-dashboard-agent-uninstall-{Guid.NewGuid():N}.ps1");
        var waitBlock = string.Join(
            Environment.NewLine,
            waitPids.Select(pid =>
                $"Wait-LiveDashboardProcessExit -ProcessId {pid}"));
        var escapedTarget = PowerShellSingleQuote(target);
        var escapedManifest = PowerShellSingleQuote(Path.Combine(target, InstallManifestStore.ManifestFileName));
        var escapedScope = PowerShellSingleQuote(scope.ToString());
        var registryRecord = InstallRegistryStore.Load(scope);
        var escapedRegistryDirectory = PowerShellSingleQuote(registryRecord?.InstallDirectory ?? "");
        var escapedRegistryHash = PowerShellSingleQuote(registryRecord?.ManifestSha256 ?? "");
        var escapedRegistryPath = PowerShellSingleQuote(
            scope == InstallScope.AllUsers
                ? @"HKLM:\Software\LiveDashboardAgent\Install\AllUsers"
                : @"HKCU:\Software\LiveDashboardAgent\Install\CurrentUser");
        var escapedUninstallRegistryPath = PowerShellSingleQuote(
            UninstallRegistryStore.RegistryPathForPowerShell(scope));
        var escapedRemoveLogs = removeLogs ? "true" : "false";
        var script = $$"""
            $ErrorActionPreference = 'SilentlyContinue'
            $trimChars = [char[]] @([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
            function Wait-LiveDashboardProcessExit {
                param([int] $ProcessId)
                while (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue) {
                    Start-Sleep -Seconds 1
                }
            }
            function Test-LiveDashboardChildPath {
                param([string] $Root, [string] $Candidate)
                $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd($trimChars)
                $candidatePath = [System.IO.Path]::GetFullPath($Candidate)
                return $candidatePath.StartsWith($rootPath + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
            }
            {{waitBlock}}
            $target = '{{escapedTarget}}'
            $manifestPath = '{{escapedManifest}}'
            $expectedScope = '{{escapedScope}}'
            $expectedRegistryDirectory = '{{escapedRegistryDirectory}}'
            $expectedRegistryHash = '{{escapedRegistryHash}}'
            $registryPath = '{{escapedRegistryPath}}'
            $uninstallRegistryPath = '{{escapedUninstallRegistryPath}}'
            $removeLogs = '{{escapedRemoveLogs}}'
            if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { exit 0 }
            if ([string]::IsNullOrWhiteSpace($expectedRegistryDirectory) -or [string]::IsNullOrWhiteSpace($expectedRegistryHash)) { exit 0 }
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            $targetFull = [System.IO.Path]::GetFullPath($target).TrimEnd($trimChars)
            $manifestTarget = [System.IO.Path]::GetFullPath([string] $manifest.InstallDirectory).TrimEnd($trimChars)
            $registryTarget = [System.IO.Path]::GetFullPath($expectedRegistryDirectory).TrimEnd($trimChars)
            if ($manifest.App -ne 'LiveDashboardAgent') { exit 0 }
            if ($manifest.Scope -ne $expectedScope) { exit 0 }
            if (-not [string]::Equals($manifestTarget, $targetFull, [System.StringComparison]::OrdinalIgnoreCase)) { exit 0 }
            if (-not [string]::Equals($registryTarget, $targetFull, [System.StringComparison]::OrdinalIgnoreCase)) { exit 0 }
            $manifestHash = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash
            if ($manifestHash -ne $expectedRegistryHash) { exit 0 }
            $skipped = 0
            foreach ($entry in $manifest.Files) {
                $relative = [string] $entry.RelativePath
                if ([string]::IsNullOrWhiteSpace($relative) -or [System.IO.Path]::IsPathRooted($relative)) { $skipped += 1; continue }
                $path = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($targetFull, $relative))
                if (-not (Test-LiveDashboardChildPath -Root $targetFull -Candidate $path)) { $skipped += 1; continue }
                if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { continue }
                $item = Get-Item -LiteralPath $path
                if ($item.Length -ne [int64] $entry.Length) { $skipped += 1; continue }
                $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
                if ($hash -ne [string] $entry.Sha256) { $skipped += 1; continue }
                Remove-Item -LiteralPath $path -Force
            }
            if ($skipped -eq 0) {
                Remove-Item -LiteralPath $manifestPath -Force
                Remove-Item -LiteralPath $registryPath -Recurse -Force
                Remove-Item -LiteralPath $uninstallRegistryPath -Recurse -Force
            }
            if ($removeLogs -eq 'true') {
                Get-ChildItem -LiteralPath $targetFull -File -Recurse | Where-Object {
                    $_.Name -eq 'agent.log' -or $_.Name.StartsWith('agent.log.', [System.StringComparison]::OrdinalIgnoreCase)
                } | ForEach-Object {
                    Remove-Item -LiteralPath $_.FullName -Force
                }
            }
            Get-ChildItem -LiteralPath $targetFull -Directory -Recurse | Sort-Object FullName -Descending | ForEach-Object {
                Remove-Item -LiteralPath $_.FullName -Force
            }
            Remove-Item -LiteralPath $targetFull -Force
            Remove-Item -LiteralPath $PSCommandPath -Force
            """;
        File.WriteAllText(scriptPath, script);
        Process.Start(new ProcessStartInfo
        {
            FileName = "powershell.exe",
            ArgumentList = { "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath },
            CreateNoWindow = true,
            UseShellExecute = false,
        });
    }

    private static string PowerShellSingleQuote(string value)
    {
        return value.Replace("'", "''");
    }
}
