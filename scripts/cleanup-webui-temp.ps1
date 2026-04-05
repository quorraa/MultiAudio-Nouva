param(
    [switch]$IncludeRunLogs = $true,
    [switch]$IncludeArtifactsCache
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$webUiRoot = Join-Path $repoRoot "WebUI"

if (-not (Test-Path -LiteralPath $webUiRoot)) {
    throw "WebUI folder not found at $webUiRoot"
}

$targets = New-Object System.Collections.Generic.List[string]

Get-ChildItem -LiteralPath $webUiRoot -Directory |
    Where-Object { $_.Name -like "artifacts_*" } |
    ForEach-Object { $targets.Add($_.FullName) }

$verifyRoot = Join-Path $webUiRoot "_verify"
if (Test-Path -LiteralPath $verifyRoot) {
    $targets.Add((Resolve-Path $verifyRoot).Path)
}

if ($IncludeArtifactsCache) {
    $artifactsObj = Join-Path $webUiRoot "artifacts\\obj"
    if (Test-Path -LiteralPath $artifactsObj) {
        $targets.Add((Resolve-Path $artifactsObj).Path)
    }
}

if ($IncludeRunLogs) {
    Get-ChildItem -LiteralPath $webUiRoot -File |
        Where-Object { $_.Name -match '^run\..*\.log$' } |
        ForEach-Object { $targets.Add($_.FullName) }
}

$removed = @()
$skipped = @()

foreach ($target in $targets | Select-Object -Unique) {
    try {
        $resolved = $target
        if (-not $resolved.StartsWith($webUiRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $skipped += [pscustomobject]@{ Path = $target; Reason = "Outside WebUI root" }
            continue
        }

        $leaf = Split-Path -Leaf $resolved
        $isSafe =
            $leaf -like "artifacts_*" -or
            $leaf -eq "_verify" -or
            $leaf -eq "obj" -or
            $leaf -match '^run\..*\.log$'

        if (-not $isSafe) {
            $skipped += [pscustomobject]@{ Path = $resolved; Reason = "Not in cleanup allowlist" }
            continue
        }

        Remove-Item -LiteralPath $resolved -Recurse -Force
        $removed += $resolved
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
Write-Host "Cleanup complete."
