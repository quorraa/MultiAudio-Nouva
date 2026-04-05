param(
    [string]$Version = "0.5.0",
    [string]$Runtime = "win-x64",
    [string]$Configuration = "Release",
    [switch]$SkipZip
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$project = Join-Path $repoRoot "WebUI\WebUI.csproj"
$publishDir = Join-Path $repoRoot "dist\portable\$Runtime\app"
$zipPath = Join-Path $repoRoot "dist\portable\MultiAudioNouva-$Version-$Runtime-portable.zip"

if (Test-Path $publishDir) {
    Remove-Item -Recurse -Force $publishDir
}

New-Item -ItemType Directory -Force -Path $publishDir | Out-Null

$publishArgs = @(
    "publish", $project,
    "-c", $Configuration,
    "-r", $Runtime,
    "-p:PublishProfile=Portable-win-x64",
    "-p:Version=$Version",
    "-p:AssemblyVersion=$Version.0",
    "-p:FileVersion=$Version.0",
    "-p:InformationalVersion=$Version",
    "-o", $publishDir
)

Write-Host "Publishing MultiAudio Nouva portable build..."
& dotnet @publishArgs

if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE."
}

$cleanupDirectories = Get-ChildItem $publishDir -Directory | Where-Object {
    $_.Name -eq "_verify" -or
    $_.Name -eq "obj" -or
    $_.Name -like "artifacts*"
}

foreach ($directory in $cleanupDirectories) {
    Remove-Item -Recurse -Force $directory.FullName
}

$cleanupFiles = @(
    "MultiOutputAudioTester.deps.json",
    "MultiOutputAudioTester.runtimeconfig.json",
    "MultiOutputAudioTester.pdb"
)

foreach ($fileName in $cleanupFiles) {
    $filePath = Join-Path $publishDir $fileName
    if (Test-Path $filePath) {
        Remove-Item -Force $filePath
    }
}

if (-not $SkipZip) {
    if (Test-Path $zipPath) {
        Remove-Item -Force $zipPath
    }

    Compress-Archive -Path (Join-Path $publishDir "*") -DestinationPath $zipPath -Force
    Write-Host "Portable zip created at: $zipPath"
}

Write-Host "Portable app directory: $publishDir"
