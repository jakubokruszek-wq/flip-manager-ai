[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Import-Module ScheduledTasks -ErrorAction Stop

$taskNames = @(
    "FlipManager Facebook Worker",
    "FlipManager OLX Worker"
)

foreach ($taskName in $taskNames) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -eq $task) {
        Write-Output "Scheduled task not installed: $taskName"
        continue
    }

    if ($task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
    Write-Output "Removed scheduled task: $taskName"
}
