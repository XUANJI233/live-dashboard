param(
    [ValidateSet("Portable", "UserInstall", "Both")]
    [string] $Mode = "Both",
    [ValidateSet("Debug", "Release")]
    [string] $Configuration = "Release",
    [ValidateSet("win-x64", "win-arm64")]
    [string] $RuntimeIdentifier = "win-x64"
)

$ErrorActionPreference = "Stop"

$project = Join-Path $PSScriptRoot "LiveDashboardAgent.csproj"
$dist = Join-Path $PSScriptRoot "dist"
$signScript = Resolve-Path (Join-Path $PSScriptRoot "..\windows\sign-windows.ps1")

function Publish-Agent {
    param(
        [ValidateSet("Portable", "UserInstall")]
        [string] $Distribution
    )

    $folder = "install"
    if ($Distribution -eq "Portable") {
        $folder = "portable"
    }
    $platform = "x64"
    if ($RuntimeIdentifier -eq "win-arm64") {
        $platform = "ARM64"
    }
    $output = Join-Path $dist $folder
    New-Item -ItemType Directory -Force -Path $output | Out-Null

    dotnet publish $project `
        -c $Configuration `
        -r $RuntimeIdentifier `
        -p:Platform=$platform `
        -p:LiveDashboardDistribution=$Distribution `
        -p:WindowsPackageType=None `
        -o $output

    $exeName = "LiveDashboardAgent.exe"
    if ($Distribution -eq "Portable") {
        $exeName = "LiveDashboardAgent.Portable.exe"
    }
    $exePath = Join-Path $output $exeName
    if (-not (Test-Path -LiteralPath $exePath)) {
        throw "Expected output was not created: $exePath"
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File $signScript -FilePath $exePath -RequireSigning
    Write-Host "Built $Distribution artifact: $exePath"
}

if ($Mode -eq "Both" -or $Mode -eq "Portable") {
    Publish-Agent -Distribution Portable
}

if ($Mode -eq "Both" -or $Mode -eq "UserInstall") {
    Publish-Agent -Distribution UserInstall
}
