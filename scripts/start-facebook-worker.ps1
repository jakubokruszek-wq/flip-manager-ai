[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = "C:\Users\mokru\Desktop\flip-manager"
$LogDirectory = Join-Path $RepoRoot "logs"
$SupervisorLogPath = Join-Path $LogDirectory "facebook-worker.log"
$WorkerEntryPoint = Join-Path $RepoRoot "workers\facebook-browser\src\index.ts"
$WorkerEnvPath = Join-Path $RepoRoot "workers\facebook-browser\.env.local"
$CertificatePath = Join-Path $env:LOCALAPPDATA "FlipManager\norton-web-mail-shield-root.pem"
$RestartDelaySeconds = 5
$HealthIntervalSeconds = 30

New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
Set-Location -LiteralPath $RepoRoot

function Write-SupervisorLog {
    param([Parameter(Mandatory = $true)][string]$Message)

    $timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffK")
    Add-Content -LiteralPath $SupervisorLogPath -Value "[$timestamp] [SUPERVISOR] $Message" -Encoding UTF8
}

function Get-NormalFacebookWorkerProcesses {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -match 'workers[\\/]facebook-browser[\\/]src[\\/]index\.ts' -and
            $_.CommandLine -notmatch '--facebook-post-id|--login|--revalidate-images|--time-diagnostic|--media-diagnostic'
        }
}

# Task Scheduler also uses IgnoreNew. The named mutex closes the remaining race
# between two supervisor launches before either child process is visible.
$supervisorMutex = New-Object System.Threading.Mutex($false, "Global\FlipManagerFacebookWorkerSupervisor")
if (-not $supervisorMutex.WaitOne(0)) {
    exit 0
}

try {
    if (-not (Test-Path -LiteralPath $WorkerEntryPoint -PathType Leaf)) {
        throw "Facebook worker entry point does not exist: $WorkerEntryPoint"
    }
    if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
        throw "Facebook worker CA certificate does not exist: $CertificatePath"
    }

    $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
    $env:NODE_EXTRA_CA_CERTS = $CertificatePath

    # A worker left behind by a terminated task, or a manually launched normal
    # worker, must not coexist with the supervisor-owned child.
    foreach ($existingWorker in @(Get-NormalFacebookWorkerProcesses)) {
        Write-SupervisorLog "Stopping unmanaged normal Facebook worker pid=$($existingWorker.ProcessId) before launch."
        Stop-Process -Id $existingWorker.ProcessId -Force -ErrorAction SilentlyContinue
    }

    while ($true) {
        $startedAt = Get-Date
        $runStamp = $startedAt.ToString("yyyyMMdd-HHmmss-fff")
        $stdoutPath = Join-Path $LogDirectory "facebook-worker-$runStamp.stdout.log"
        $stderrPath = Join-Path $LogDirectory "facebook-worker-$runStamp.stderr.log"
        $arguments = "--env-file-if-exists=`"$WorkerEnvPath`" --experimental-strip-types `"$WorkerEntryPoint`""

        Write-SupervisorLog "Starting Facebook worker (startedAt=$($startedAt.ToString('o')); stdout=$stdoutPath; stderr=$stderrPath)."
        $startInfo = New-Object System.Diagnostics.ProcessStartInfo
        $startInfo.FileName = $nodePath
        $startInfo.Arguments = $arguments
        $startInfo.WorkingDirectory = $RepoRoot
        $startInfo.UseShellExecute = $false
        $startInfo.CreateNoWindow = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.RedirectStandardError = $true
        $worker = New-Object System.Diagnostics.Process
        $worker.StartInfo = $startInfo
        if (-not $worker.Start()) {
            throw "System.Diagnostics.Process failed to start the Facebook worker."
        }
        $stdoutStream = [IO.FileStream]::new($stdoutPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        $stderrStream = [IO.FileStream]::new($stderrPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite)
        $stdoutCopy = $worker.StandardOutput.BaseStream.CopyToAsync($stdoutStream)
        $stderrCopy = $worker.StandardError.BaseStream.CopyToAsync($stderrStream)
        Write-SupervisorLog "Facebook worker started pid=$($worker.Id)."

        $lastHealthLog = Get-Date
        while (-not $worker.HasExited) {
            Start-Sleep -Seconds 2
            $worker.Refresh()

            if (((Get-Date) - $lastHealthLog).TotalSeconds -ge $HealthIntervalSeconds) {
                Write-SupervisorLog "Facebook worker heartbeat pid=$($worker.Id) alive=true."
                foreach ($duplicate in @(Get-NormalFacebookWorkerProcesses | Where-Object { $_.ProcessId -ne $worker.Id })) {
                    Write-SupervisorLog "Stopping duplicate normal Facebook worker pid=$($duplicate.ProcessId)."
                    Stop-Process -Id $duplicate.ProcessId -Force -ErrorAction SilentlyContinue
                }
                $lastHealthLog = Get-Date
            }
        }

        $worker.WaitForExit()
        $stdoutCopy.GetAwaiter().GetResult()
        $stderrCopy.GetAwaiter().GetResult()
        $stdoutStream.Dispose()
        $stderrStream.Dispose()
        $finishedAt = Get-Date
        $exitCode = $worker.ExitCode
        Write-SupervisorLog "Facebook worker exited code=$exitCode pid=$($worker.Id) finishedAt=$($finishedAt.ToString('o')) stderr=$stderrPath stdout=$stdoutPath."

        if ($exitCode -eq 0) {
            Write-SupervisorLog "Facebook worker exited normally; supervisor stopping without restart."
            exit 0
        }

        Write-SupervisorLog "Restarting Facebook worker in $RestartDelaySeconds seconds after unexpected exit code $exitCode."
        Start-Sleep -Seconds $RestartDelaySeconds
    }
}
catch {
    Write-SupervisorLog "Supervisor fatal error: $($_.Exception.Message)"
    throw
}
finally {
    $supervisorMutex.ReleaseMutex()
    $supervisorMutex.Dispose()
}
