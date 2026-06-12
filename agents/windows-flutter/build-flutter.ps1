param(
    [ValidateSet("Portable", "UserInstall", "Both")]
    [string] $Mode = "Both",
    [ValidateSet("Release", "Debug")]
    [string] $Configuration = "Release"
)

$ErrorActionPreference = "Stop"

$dist = Join-Path $PSScriptRoot "dist"
$packageDist = Join-Path $dist "packages"
$windowsBuild = Join-Path $PSScriptRoot "build\windows"
$buildMode = $Configuration.ToLowerInvariant()
$signScript = Resolve-Path (Join-Path $PSScriptRoot "sign-windows.ps1")

function Clear-AgentDirectory {
    param([string] $Path)

    $trimChars = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $distRoot = [System.IO.Path]::GetFullPath($dist).TrimEnd($trimChars)
    $target = [System.IO.Path]::GetFullPath($Path).TrimEnd($trimChars)
    if (-not $target.StartsWith($distRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean path outside dist: $target"
    }
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

function Clear-WindowsBuildCache {
    if (-not (Test-Path -LiteralPath $windowsBuild)) {
        return
    }
    $trimChars = [char[]]@([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)
    $projectRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd($trimChars)
    $target = [System.IO.Path]::GetFullPath($windowsBuild).TrimEnd($trimChars)
    if (-not $target.StartsWith($projectRoot + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean build path outside project: $target"
    }
    Remove-Item -LiteralPath $target -Recurse -Force
}

function Copy-AgentBundle {
    param(
        [string] $SourceDirectory,
        [string] $TargetDirectory
    )

    Clear-AgentDirectory -Path $TargetDirectory
    New-Item -ItemType Directory -Force -Path $TargetDirectory | Out-Null
    Copy-Item -Path (Join-Path $SourceDirectory "*") -Destination $TargetDirectory -Recurse -Force
}

function New-AgentArchive {
    param(
        [ValidateSet("Portable", "UserInstall")]
        [string] $Distribution,
        [string] $SourceDirectory
    )

    New-Item -ItemType Directory -Force -Path $packageDist | Out-Null
    $packageName = "LiveDashboardAgent"
    if ($Distribution -eq "Portable") {
        $packageName += "-portable"
    } else {
        $packageName += "-installer"
    }
    $packageName += "-win-x64.zip"
    $packagePath = Join-Path $packageDist $packageName
    if (Test-Path -LiteralPath $packagePath) {
        Remove-Item -LiteralPath $packagePath -Force
    }
    Compress-Archive -Path (Join-Path $SourceDirectory "*") -DestinationPath $packagePath -Force
    Write-Host "Packaged $Distribution artifact: $packagePath"
}

function Publish-Agent {
    param(
        [ValidateSet("Portable", "UserInstall")]
        [string] $Distribution
    )

    $define = "portable"
    $folder = "portable"
    if ($Distribution -eq "UserInstall") {
        $define = "user_install"
        $folder = "install"
    }

    flutter build windows "--$buildMode" "--dart-define=LIVE_DASHBOARD_DISTRIBUTION=$define"

    $bundle = Join-Path $PSScriptRoot "build\windows\x64\runner\$Configuration"
    $output = Join-Path $dist $folder
    Copy-AgentBundle -SourceDirectory $bundle -TargetDirectory $output

    $exePath = Join-Path $output "LiveDashboardAgent.exe"
    if (-not (Test-Path -LiteralPath $exePath)) {
        throw "Expected output was not created: $exePath"
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File $signScript -FilePath $exePath -RequireSigning
    Write-Host "Built $Distribution artifact: $exePath"
    New-AgentArchive -Distribution $Distribution -SourceDirectory $output
}

Clear-WindowsBuildCache

if ($Mode -eq "Both" -or $Mode -eq "Portable") {
    Publish-Agent -Distribution Portable
}

if ($Mode -eq "Both" -or $Mode -eq "UserInstall") {
    Publish-Agent -Distribution UserInstall
}
