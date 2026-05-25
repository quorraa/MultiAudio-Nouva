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

function Stop-PortableAppProcesses {
    param(
        [string]$TargetDirectory
    )

    $resolvedTarget = [System.IO.Path]::GetFullPath($TargetDirectory).TrimEnd('\')
    $currentProcessId = $PID

    $processes = Get-CimInstance Win32_Process | Where-Object {
        if ($_.ProcessId -eq $currentProcessId) {
            return $false
        }

        $executablePath = $_.ExecutablePath
        $commandLine = $_.CommandLine
        $isPublishedApp =
            $executablePath -and
            ([System.IO.Path]::GetFullPath($executablePath).StartsWith($resolvedTarget, [System.StringComparison]::OrdinalIgnoreCase))

        $usesPublishDir =
            $commandLine -and
            ($commandLine.IndexOf($resolvedTarget, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
             $commandLine.IndexOf($TargetDirectory, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)

        $isPublishedApp -or $usesPublishDir
    }

    foreach ($process in $processes) {
        Write-Host "Stopping process using portable app folder: $($process.Name) ($($process.ProcessId))"
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Remove-DirectoryWithRetry {
    param(
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        return
    }

    Stop-PortableAppProcesses -TargetDirectory $Path

    $lastError = $null
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Remove-Item -Recurse -Force $Path
            return
        }
        catch {
            $lastError = $_
            Start-Sleep -Milliseconds (250 * $attempt)
            [System.GC]::Collect()
            [System.GC]::WaitForPendingFinalizers()
        }
    }

    throw "Failed to remove '$Path' after stopping matching processes. Last error: $($lastError.Exception.Message)"
}

function Clear-DirectoryContentsWithRetry {
    param(
        [string]$Path
    )

    if (-not (Test-Path $Path)) {
        return
    }

    Stop-PortableAppProcesses -TargetDirectory $Path

    $lastError = $null
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            Get-ChildItem -LiteralPath $Path -Force | ForEach-Object {
                Remove-Item -LiteralPath $_.FullName -Recurse -Force
            }
            return
        }
        catch {
            $lastError = $_
            Start-Sleep -Milliseconds (250 * $attempt)
            [System.GC]::Collect()
            [System.GC]::WaitForPendingFinalizers()
        }
    }

    throw "Failed to clear '$Path' after stopping matching processes. Last error: $($lastError.Exception.Message)"
}

if (Test-Path $publishDir) {
    Clear-DirectoryContentsWithRetry -Path $publishDir
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
