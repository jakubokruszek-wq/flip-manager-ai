[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Import-Module ScheduledTasks -ErrorAction Stop

$workers = @(
    [pscustomobject]@{
        TaskName = "FlipManager Facebook Worker"
        ProcessPattern = "workers[\\/]facebook-browser[\\/]src[\\/]index\.ts"
    },
    [pscustomobject]@{
        TaskName = "FlipManager OLX Worker"
        ProcessPattern = "workers[\\/]olx-browser[\\/]src[\\/]index\.ts"
    }
)

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

$nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")
foreach ($worker in $workers) {
    $matchingProcesses = @($nodeProcesses | Where-Object { $_.CommandLine -match $worker.ProcessPattern })
    foreach ($process in $matchingProcesses) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        Write-Output "Stopped worker process $($process.ProcessId) for $($worker.TaskName)"
    }
}

foreach ($worker in $workers) {
    Start-ScheduledTask -TaskName $worker.TaskName -ErrorAction Stop
    Write-Output "Started scheduled task: $($worker.TaskName)"
}
