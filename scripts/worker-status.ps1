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

$nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")

foreach ($worker in $workers) {
    Write-Output "=== $($worker.Label) ==="
    $task = Get-ScheduledTask -TaskName $worker.TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-Output "TaskExists: NO"
        Write-Output "TaskState: NOT_INSTALLED"
        Write-Output "LastRunTime: N/A"
        Write-Output "LastTaskResult: N/A"
    }
    else {
        $info = Get-ScheduledTaskInfo -TaskName $worker.TaskName
        Write-Output "TaskExists: YES"
        Write-Output "TaskState: $($task.State)"
        Write-Output "LastRunTime: $($info.LastRunTime.ToString('yyyy-MM-ddTHH:mm:ssK'))"
        Write-Output "LastTaskResult: $($info.LastTaskResult)"
    }

    $matchingProcesses = @($nodeProcesses | Where-Object { $_.CommandLine -match $worker.ProcessPattern })
    Write-Output "ProcessRunning: $(if ($matchingProcesses.Count -gt 0) { 'YES' } else { 'NO' })"
    Write-Output "ProcessIds: $(if ($matchingProcesses.Count -gt 0) { ($matchingProcesses.ProcessId -join ',') } else { 'NONE' })"
    Write-Output "LogPath: $($worker.LogPath)"
    Write-Output "LastLogLines:"
    if (Test-Path -LiteralPath $worker.LogPath -PathType Leaf) {
        Get-Content -LiteralPath $worker.LogPath -Tail 10
    }
    else {
        Write-Output "(log file does not exist)"
    }
    Write-Output ""
}
