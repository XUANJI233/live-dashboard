param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,

    [switch]$RequireSigning
)

$ErrorActionPreference = "Stop"

function Get-EnvBool {
    param(
        [string]$Name,
        [bool]$Default = $false
    )
    $value = [Environment]::GetEnvironmentVariable($Name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $Default
    }
    $normalized = $value.Trim().ToLowerInvariant()
    if ($normalized -eq "true") {
        return $true
    }
    if ($normalized -eq "false") {
        return $false
    }
    throw "$Name must be true or false"
}

function Find-SignTool {
    $configured = [Environment]::GetEnvironmentVariable("WINDOWS_SIGNTOOL_PATH")
    if (-not [string]::IsNullOrWhiteSpace($configured)) {
        if (Test-Path -LiteralPath $configured) {
            return (Resolve-Path -LiteralPath $configured).Path
        }
        throw "WINDOWS_SIGNTOOL_PATH does not exist: $configured"
    }

    $fromPath = Get-Command "signtool.exe" -ErrorAction SilentlyContinue
    if ($fromPath) {
        return $fromPath.Source
    }

    $roots = @(
        ${env:ProgramFiles(x86)},
        $env:ProgramFiles
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

    $candidates = @()
    foreach ($root in $roots) {
        $kits = Join-Path $root "Windows Kits\10\bin"
        if (Test-Path -LiteralPath $kits) {
            $candidates += Get-ChildItem -Path $kits -Recurse -Filter "signtool.exe" -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match "\\x64\\signtool\.exe$" }
        }
    }

    $selected = $candidates |
        Sort-Object -Property FullName -Descending |
        Select-Object -First 1
    if ($selected) {
        return $selected.FullName
    }

    throw "signtool.exe not found. Install Windows SDK or set WINDOWS_SIGNTOOL_PATH."
}

function Invoke-Checked {
    param(
        [string]$FileName,
        [string[]]$Arguments
    )
    & $FileName @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FileName failed with exit code $LASTEXITCODE"
    }
}

function New-TemporarySelfSignedPfx {
    $subject = [Environment]::GetEnvironmentVariable("WINDOWS_SELF_SIGN_SUBJECT")
    if ([string]::IsNullOrWhiteSpace($subject)) {
        $subject = "CN=Live Dashboard Windows Agent Self-Signed"
    }

    $rsa = [System.Security.Cryptography.RSA]::Create(3072)
    try {
        $distinguishedName = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new($subject)
        $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
            $distinguishedName,
            $rsa,
            [System.Security.Cryptography.HashAlgorithmName]::SHA256,
            [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
        )
        $request.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
                [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
                $true
            )
        )
        $oids = [System.Security.Cryptography.OidCollection]::new()
        [void]$oids.Add([System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.3", "Code Signing"))
        $request.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($oids, $false)
        )
        $notBefore = [System.DateTimeOffset]::Now.AddMinutes(-10)
        $notAfter = [System.DateTimeOffset]::Now.AddYears(1)
        $cert = $request.CreateSelfSigned($notBefore, $notAfter)
        try {
            $password = [guid]::NewGuid().ToString("N")
            $path = Join-Path ([System.IO.Path]::GetTempPath()) ("live-dashboard-selfsign-" + [guid]::NewGuid().ToString("N") + ".pfx")
            $bytes = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx, $password)
            [System.IO.File]::WriteAllBytes($path, $bytes)
            return @{
                Path = $path
                Password = $password
            }
        } finally {
            $cert.Dispose()
        }
    } finally {
        $rsa.Dispose()
    }
}

$resolvedFile = (Resolve-Path -LiteralPath $FilePath).Path
$skipSigning = Get-EnvBool -Name "WINDOWS_SKIP_SIGNING" -Default $false
if ($skipSigning) {
    Write-Warning "WINDOWS_SKIP_SIGNING=true, leaving $resolvedFile unsigned."
    exit 0
}
$selfSign = Get-EnvBool -Name "WINDOWS_SELF_SIGN" -Default $false

$certBase64 = [Environment]::GetEnvironmentVariable("WINDOWS_CODESIGN_CERT_BASE64")
$certPath = [Environment]::GetEnvironmentVariable("WINDOWS_CODESIGN_CERT_PATH")
$certThumbprint = [Environment]::GetEnvironmentVariable("WINDOWS_CODESIGN_CERT_THUMBPRINT")
$certPassword = [Environment]::GetEnvironmentVariable("WINDOWS_CODESIGN_CERT_PASSWORD")
$hasConfiguredCertificate = -not [string]::IsNullOrWhiteSpace($certBase64) -or
    -not [string]::IsNullOrWhiteSpace($certPath) -or
    -not [string]::IsNullOrWhiteSpace($certThumbprint)
$selfSignedPfxPath = $null

if (-not $hasConfiguredCertificate) {
    if ($selfSign) {
        $selfSignedPfx = New-TemporarySelfSignedPfx
        $selfSignedPfxPath = $selfSignedPfx.Path
        $certPath = $selfSignedPfx.Path
        $certPassword = $selfSignedPfx.Password
        Write-Warning "Using a temporary self-signed code signing certificate. This reduces unsigned-binary friction but does not create a trusted publisher."
    } else {
        if ($RequireSigning) {
            throw "Windows signing is required. Set WINDOWS_CODESIGN_CERT_BASE64, WINDOWS_CODESIGN_CERT_PATH, WINDOWS_CODESIGN_CERT_THUMBPRINT, or set WINDOWS_SELF_SIGN=true / WINDOWS_SKIP_SIGNING=true."
        }
        Write-Warning "No Windows signing certificate configured; $resolvedFile was not signed."
        exit 0
    }
}

$signTool = Find-SignTool
$timestampUrl = [Environment]::GetEnvironmentVariable("WINDOWS_TIMESTAMP_URL")
if ([string]::IsNullOrWhiteSpace($timestampUrl)) {
    $timestampUrl = "http://timestamp.digicert.com"
}

$tempCertPath = $null
try {
    $signArgs = @("sign", "/fd", "SHA256")
    if ($hasConfiguredCertificate) {
        $signArgs += @("/tr", $timestampUrl, "/td", "SHA256")
    }

    if (-not [string]::IsNullOrWhiteSpace($certBase64)) {
        $tempCertPath = Join-Path ([System.IO.Path]::GetTempPath()) ("live-dashboard-codesign-" + [guid]::NewGuid().ToString("N") + ".pfx")
        [System.IO.File]::WriteAllBytes($tempCertPath, [Convert]::FromBase64String($certBase64))
        $signArgs += @("/f", $tempCertPath)
        if (-not [string]::IsNullOrWhiteSpace($certPassword)) {
            $signArgs += @("/p", $certPassword)
        }
    } elseif (-not [string]::IsNullOrWhiteSpace($certPath)) {
        $resolvedCert = (Resolve-Path -LiteralPath $certPath).Path
        $signArgs += @("/f", $resolvedCert)
        if (-not [string]::IsNullOrWhiteSpace($certPassword)) {
            $signArgs += @("/p", $certPassword)
        }
    } else {
        $storeName = [Environment]::GetEnvironmentVariable("WINDOWS_CODESIGN_CERT_STORE_NAME")
        if ([string]::IsNullOrWhiteSpace($storeName)) {
            $storeName = "My"
        }
        $storeLocation = [Environment]::GetEnvironmentVariable("WINDOWS_CODESIGN_CERT_STORE_LOCATION")
        $signArgs += @("/sha1", $certThumbprint.Trim(), "/s", $storeName)
        if ($storeLocation -and $storeLocation.Trim().Equals("LocalMachine", [System.StringComparison]::OrdinalIgnoreCase)) {
            $signArgs += "/sm"
        }
    }

    $signArgs += $resolvedFile
    Invoke-Checked -FileName $signTool -Arguments $signArgs
    if ($hasConfiguredCertificate) {
        Invoke-Checked -FileName $signTool -Arguments @("verify", "/pa", "/v", $resolvedFile)
        Write-Host "Signed and verified: $resolvedFile"
    } else {
        Write-Warning "Self-signed Authenticode signature embedded. This is not trusted by Windows unless the certificate is installed as trusted."
        Write-Host "Self-signed: $resolvedFile"
    }
} finally {
    if ($tempCertPath -and (Test-Path -LiteralPath $tempCertPath)) {
        Remove-Item -LiteralPath $tempCertPath -Force
    }
    if ($selfSignedPfxPath -and (Test-Path -LiteralPath $selfSignedPfxPath)) {
        Remove-Item -LiteralPath $selfSignedPfxPath -Force
    }
}
