[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = "C:\Users\mokru\Desktop\flip-manager"
$env:NODE_EXTRA_CA_CERTS = Join-Path $env:LOCALAPPDATA "FlipManager\norton-web-mail-shield-root.pem"
$LogDirectory = Join-Path $RepoRoot "logs"
$LogPath = Join-Path $LogDirectory "facebook-worker.log"
$RestartWindow = [TimeSpan]::FromMinutes(2)
$NormalDelaySeconds = 5
$CrashLoopDelaySeconds = 300
$MaxRestartsInWindow = 5

New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
Set-Location -LiteralPath $RepoRoot

# Protect against duplicate manual launches in addition to Task Scheduler's
# MultipleInstances=IgnoreNew setting.
$supervisorMutex = New-Object System.Threading.Mutex($false, "Global\FlipManagerFacebookWorkerSupervisor")
if (-not $supervisorMutex.WaitOne(0)) {
    exit 0
}

function Write-SupervisorLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    $timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffK")
    Add-Content -LiteralPath $LogPath -Value "[$timestamp] [SUPERVISOR] $Message" -Encoding UTF8
}

$restartTimes = New-Object "System.Collections.Generic.List[datetime]"

while ($true) {
    $startedAt = Get-Date
    Write-SupervisorLog "Starting Facebook worker (startedAt=$($startedAt.ToString('o')))."
    $exitCode = 1
    $stdoutPath = [IO.Path]::GetTempFileName()
    $stderrPath = [IO.Path]::GetTempFileName()

    try {
        & npm.cmd run facebook-worker 1> $stdoutPath 2> $stderrPath
        $exitCode = $LASTEXITCODE
    }
    catch {
        Write-SupervisorLog "Worker launch failed: $($_.Exception.Message)"
    }

    foreach ($line in (Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue)) {
        Add-Content -LiteralPath $LogPath -Value "[$((Get-Date).ToString('o'))] [WORKER][stdout] $line" -Encoding UTF8
    }
    foreach ($line in (Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue)) {
        Add-Content -LiteralPath $LogPath -Value "[$((Get-Date).ToString('o'))] [WORKER][stderr] $line" -Encoding UTF8
    }
    Remove-Item -LiteralPath $stdoutPath,$stderrPath -Force -ErrorAction SilentlyContinue

    $finishedAt = Get-Date
    Write-SupervisorLog "Facebook worker exited with code $exitCode (finishedAt=$($finishedAt.ToString('o')))."
    if ($exitCode -eq 0) {
        Write-SupervisorLog "Worker exited normally; supervisor stopping without restart."
        exit 0
    }

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
        Write-SupervisorLog "Restarting in $NormalDelaySeconds seconds after unexpected exit code $exitCode."
        Start-Sleep -Seconds $NormalDelaySeconds
    }
}
