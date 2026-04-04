param(
    [string]$Version = "0.1.0",
    [string]$Runtime = "win-x64",
    [string]$Configuration = "Release",
    [string]$IsccPath
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$publishScript = Join-Path $PSScriptRoot "publish-portable.ps1"
$publishDir = Join-Path $repoRoot "dist\portable\$Runtime\app"
$outputDir = Join-Path $repoRoot "dist\installer"
$issPath = Join-Path $repoRoot "packaging\MultiAudioNouva.iss"

if (-not $IsccPath) {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe"),
        (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe")
    ) | Where-Object { $_ -and (Test-Path $_) }

    $IsccPath = $candidates | Select-Object -First 1
}

if (-not $IsccPath -or -not (Test-Path $IsccPath)) {
    throw "Inno Setup compiler not found. Install Inno Setup 6 or pass -IsccPath."
}

& $publishScript -Version $Version -Runtime $Runtime -Configuration $Configuration -SkipZip

New-Item -ItemType Directory -Force -Path $outputDir | Out-Null

Write-Host "Building installer with Inno Setup..."
& $IsccPath "/DAppVersion=$Version" "/DSourceDir=$publishDir" "/DOutputDir=$outputDir" $issPath

Write-Host "Installer output directory: $outputDir"
