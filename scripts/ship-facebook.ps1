[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$CommitMessage,

    [switch]$DryRun
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$AllowedPrefixes = @(
    "workers/facebook-browser/",
    "features/facebook-worker/",
    "features/facebook-watcher/",
    "app/api/facebook-worker/"
)

$ExcludedPaths = @(
    ".codex-tmp/",
    "workers/facebook-browser/src/errors.ts"
)

function Stop-WithError {
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-Error $Message
    exit 1
}

function Invoke-Git {
    param(
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [switch]$Capture
    )

    if ($Capture) {
        $output = @(& git @Arguments)
        if ($LASTEXITCODE -ne 0) {
            Stop-WithError "Git command failed (exit $LASTEXITCODE): git $($Arguments -join ' ')"
        }
        return $output
    }

    & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError "Git command failed (exit $LASTEXITCODE): git $($Arguments -join ' ')"
    }
}

function Normalize-GitPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return $Path.Trim().Trim('"').Replace("\", "/")
}

function Test-AllowedPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $normalized = Normalize-GitPath $Path
    foreach ($excluded in $ExcludedPaths) {
        if ($normalized -eq $excluded -or $normalized.StartsWith($excluded, [System.StringComparison]::Ordinal)) {
            return $false
        }
    }
    foreach ($prefix in $AllowedPrefixes) {
        if ($normalized.StartsWith($prefix, [System.StringComparison]::Ordinal)) {
            return $true
        }
    }
    return $false
}

# Resolve the repository first, then run every Git command from its root.
$repoRootOutput = @(& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or $repoRootOutput.Count -eq 0) {
    Stop-WithError "The current directory is not inside a Git repository."
}
$repoRoot = $repoRootOutput[0]

Push-Location -LiteralPath $repoRoot
try {
    Write-Host "Current Git status:"
    Invoke-Git -Arguments @("status", "--short")

    # Include unstaged, already staged and untracked paths, then apply the allowlist.
    $changedPaths = @(
        Invoke-Git -Arguments @("-c", "core.quotepath=false", "diff", "--name-only") -Capture
        Invoke-Git -Arguments @("-c", "core.quotepath=false", "diff", "--cached", "--name-only") -Capture
        Invoke-Git -Arguments @("-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard") -Capture
    ) | ForEach-Object { Normalize-GitPath $_ } | Sort-Object -Unique

    $filesToStage = @($changedPaths | Where-Object { Test-AllowedPath $_ })

    Write-Host "Files selected by the Facebook allowlist:"
    if ($filesToStage.Count -eq 0) {
        Write-Host "  (none)"
        Write-Host "Nothing to stage."
        exit 0
    }
    $filesToStage | ForEach-Object { Write-Host "  $_" }

    # Refuse to commit unrelated files that were staged before this script started.
    $alreadyStaged = @(Invoke-Git -Arguments @("-c", "core.quotepath=false", "diff", "--cached", "--name-only") -Capture | ForEach-Object { Normalize-GitPath $_ })
    $unsafeStaged = @($alreadyStaged | Where-Object { -not (Test-AllowedPath $_) })
    if ($unsafeStaged.Count -gt 0) {
        Write-Host "Already staged files outside the allowlist:"
        $unsafeStaged | ForEach-Object { Write-Host "  $_" }
        Stop-WithError "Refusing to continue because the next commit would include files outside the Facebook allowlist."
    }

    if ($DryRun) {
        Write-Host "Dry run complete. No files were staged, committed or pushed."
        exit 0
    }

    # Stage exact paths only. Never use broad Git pathspecs.
    Invoke-Git -Arguments (@("add", "--") + $filesToStage)

    Write-Host "Staged diff summary:"
    Invoke-Git -Arguments @("diff", "--cached", "--stat")
    Write-Host "Git status after staging:"
    Invoke-Git -Arguments @("status", "--short")

    $stagedAfter = @(Invoke-Git -Arguments @("-c", "core.quotepath=false", "diff", "--cached", "--name-only") -Capture | ForEach-Object { Normalize-GitPath $_ })
    $unsafeAfter = @($stagedAfter | Where-Object { -not (Test-AllowedPath $_) })
    if ($unsafeAfter.Count -gt 0) {
        Stop-WithError "Safety check failed: staging contains a file outside the Facebook allowlist."
    }

    $answer = Read-Host "Commit and push these changes? [y/N]"
    if ($answer -notmatch '^[yY]$') {
        Write-Host "Commit and push cancelled. Selected files remain staged."
        exit 0
    }

    Invoke-Git -Arguments @("commit", "-m", $CommitMessage)
    Invoke-Git -Arguments @("push", "origin", "main")
    Write-Host "Push complete. Wait for Vercel Ready, then restart Facebook worker and run exactly one production scan."
}
finally {
    Pop-Location
}
