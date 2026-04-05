param(
    [switch]$IncludeRelease
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$projectRoot = Join-Path $repoRoot "MultiOutputAudioTester"
$objRoot = Join-Path $projectRoot "obj"

if (-not (Test-Path -LiteralPath $objRoot)) {
    throw "WPF obj folder not found at $objRoot"
}

$targets = New-Object System.Collections.Generic.List[string]

$debugTarget = Join-Path $objRoot "Debug\net8.0-windows"
if (Test-Path -LiteralPath $debugTarget) {
    $targets.Add((Resolve-Path $debugTarget).Path)
}

if ($IncludeRelease) {
    $releaseTarget = Join-Path $objRoot "Release\net8.0-windows"
    if (Test-Path -LiteralPath $releaseTarget) {
        $targets.Add((Resolve-Path $releaseTarget).Path)
    }
}

$rootVerifyTarget = Join-Path $repoRoot "artifacts_verify_obj"
if (Test-Path -LiteralPath $rootVerifyTarget) {
    $targets.Add((Resolve-Path $rootVerifyTarget).Path)
}

$removed = @()
$skipped = @()

foreach ($target in $targets | Select-Object -Unique) {
    try {
        if (-not $target.StartsWith($objRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $skipped += [pscustomobject]@{ Path = $target; Reason = "Outside MultiOutputAudioTester obj root" }
            continue
        }

        $leaf = Split-Path -Leaf $target
        $isAllowedTarget =
            $leaf -eq "net8.0-windows" -or
            $leaf -eq "artifacts_verify_obj"

        if (-not $isAllowedTarget) {
            $skipped += [pscustomobject]@{ Path = $target; Reason = "Not an allowlisted generated build folder" }
            continue
        }

        Remove-Item -LiteralPath $target -Recurse -Force
        $removed += $target
    }
    catch {
        $skipped += [pscustomobject]@{ Path = $target; Reason = $_.Exception.Message }
    }
}

Write-Host ""
Write-Host "Removed:"
if ($removed.Count -eq 0) {
    Write-Host "  (none)"
}
else {
    $removed | ForEach-Object { Write-Host "  $_" }
}

Write-Host ""
Write-Host "Skipped:"
if ($skipped.Count -eq 0) {
    Write-Host "  (none)"
}
else {
    $skipped | ForEach-Object { Write-Host "  $($_.Path) :: $($_.Reason)" }
}

Write-Host ""
Write-Host "WPF obj cleanup complete."
