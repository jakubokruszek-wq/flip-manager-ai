[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = "C:\Users\mokru\Desktop\flip-manager"
Import-Module ScheduledTasks -ErrorAction Stop

$workers = @(
    [pscustomobject]@{
        Label = "Facebook"
        TaskName = "FlipManager Facebook Worker"
        ProcessPattern = "workers[\\/]facebook-browser[\\/]src[\\/]index\.ts"
        LogPath = Join-Path $RepoRoot "logs\facebook-worker.log"
    },
    [pscustomobject]@{
        Label = "OLX"
        TaskName = "FlipManager OLX Worker"
        ProcessPattern = "workers[\\/]olx-browser[\\/]src[\\/]index\.ts"
        LogPath = Join-Path $RepoRoot "logs\olx-worker.log"
    }
)

function Get-WorkerProcesses {
    param([Parameter(Mandatory = $true)][string]$Pattern)

    return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match $Pattern })
}

function Wait-ForWorkers {
    param([int]$TimeoutSeconds = 45)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")
        $allReady = $true
        foreach ($worker in $workers) {
            $matchingProcesses = @($nodeProcesses | Where-Object { $_.CommandLine -match $worker.ProcessPattern })
            if ($matchingProcesses.Count -ne 1) {
                $allReady = $false
                break
            }
        }
        if ($allReady) {
            return
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)

    throw "Workers did not reach exactly one process each within $TimeoutSeconds seconds."
}

# Establish a clean worker-only baseline without touching unrelated Node processes.
foreach ($worker in $workers) {
    $task = Get-ScheduledTask -TaskName $worker.TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        throw "Scheduled task is not installed: $($worker.TaskName)"
    }
    if ($task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $worker.TaskName -ErrorAction Stop
    }
}

Start-Sleep -Seconds 2

foreach ($worker in $workers) {
    foreach ($process in (Get-WorkerProcesses -Pattern $worker.ProcessPattern)) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    }
}

foreach ($worker in $workers) {
    Start-ScheduledTask -TaskName $worker.TaskName -ErrorAction Stop
}

Wait-ForWorkers -TimeoutSeconds 45

$initialProcessIds = @{}
foreach ($worker in $workers) {
    $processes = Get-WorkerProcesses -Pattern $worker.ProcessPattern
    $initialProcessIds[$worker.TaskName] = @($processes.ProcessId)
    if (-not (Test-Path -LiteralPath $worker.LogPath -PathType Leaf)) {
        throw "Worker log was not created: $($worker.LogPath)"
    }
    $taskInfo = Get-ScheduledTaskInfo -TaskName $worker.TaskName -ErrorAction Stop
    if ($null -eq $taskInfo) {
        throw "Unable to read scheduled task status: $($worker.TaskName)"
    }
}

# IgnoreNew must prevent a second supervisor and a second Node worker.
foreach ($worker in $workers) {
    Start-ScheduledTask -TaskName $worker.TaskName -ErrorAction Stop
}
Start-Sleep -Seconds 5

foreach ($worker in $workers) {
    $processes = Get-WorkerProcesses -Pattern $worker.ProcessPattern
    $currentIds = @($processes.ProcessId | Sort-Object)
    $expectedIds = @($initialProcessIds[$worker.TaskName] | Sort-Object)
    if ($currentIds.Count -ne 1 -or (Compare-Object -ReferenceObject $expectedIds -DifferenceObject $currentIds)) {
        throw "Duplicate-instance protection failed for $($worker.TaskName)."
    }
    Write-Output "$($worker.Label): PASS (PID $($currentIds[0]))"
}

Write-Output "WORKER_AUTOSTART_TEST: PASS"
