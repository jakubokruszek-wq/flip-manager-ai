[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = "C:\Users\mokru\Desktop\flip-manager"
$LogDirectory = Join-Path $RepoRoot "logs"
$LogPath = Join-Path $LogDirectory "facebook-worker.log"
$RestartWindow = [TimeSpan]::FromMinutes(2)
$NormalDelaySeconds = 10
$CrashLoopDelaySeconds = 300
$MaxRestartsInWindow = 5

New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
Set-Location -LiteralPath $RepoRoot

function Write-SupervisorLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    $timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffK")
    Add-Content -LiteralPath $LogPath -Value "[$timestamp] [SUPERVISOR] $Message" -Encoding UTF8
}

$restartTimes = New-Object "System.Collections.Generic.List[datetime]"

while ($true) {
    $startedAt = Get-Date
    Write-SupervisorLog "Starting Facebook worker."
    $exitCode = 1

    try {
        & npm.cmd run facebook-worker 2>&1 | ForEach-Object {
            Add-Content -LiteralPath $LogPath -Value ([string]$_) -Encoding UTF8
        }
        $exitCode = $LASTEXITCODE
    }
    catch {
        Write-SupervisorLog "Worker launch failed: $($_.Exception.Message)"
    }

    Write-SupervisorLog "Facebook worker exited with code $exitCode."
    $now = Get-Date
    $restartTimes.Add($now)
    $windowStart = $now.Subtract($RestartWindow)

    for ($index = $restartTimes.Count - 1; $index -ge 0; $index--) {
        if ($restartTimes[$index] -lt $windowStart) {
            $restartTimes.RemoveAt($index)
        }
    }

    if ($restartTimes.Count -ge $MaxRestartsInWindow) {
        Write-SupervisorLog "Crash-loop protection activated; waiting 300 seconds."
        Start-Sleep -Seconds $CrashLoopDelaySeconds
        $restartTimes.Clear()
    }
    else {
        Write-SupervisorLog "Restarting in 10 seconds."
        Start-Sleep -Seconds $NormalDelaySeconds
    }
}
