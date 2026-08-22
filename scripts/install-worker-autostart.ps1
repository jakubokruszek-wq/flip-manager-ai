[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$RepoRoot = "C:\Users\mokru\Desktop\flip-manager"
$PowerShellExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$CurrentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

Import-Module ScheduledTasks -ErrorAction Stop

$taskDefinitions = @(
    [pscustomobject]@{
        Name = "FlipManager Facebook Worker"
        Script = Join-Path $RepoRoot "scripts\start-facebook-worker.ps1"
        Description = "Runs the Flip Manager Facebook worker for the logged-on user."
    },
    [pscustomobject]@{
        Name = "FlipManager OLX Worker"
        Script = Join-Path $RepoRoot "scripts\start-olx-worker.ps1"
        Description = "Runs the Flip Manager OLX worker for the logged-on user."
    }
)

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

foreach ($task in $taskDefinitions) {
    if (-not (Test-Path -LiteralPath $task.Script -PathType Leaf)) {
        throw "Worker start script not found: $($task.Script)"
    }

    $arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}"' -f $task.Script
    $action = New-ScheduledTaskAction -Execute $PowerShellExe -Argument $arguments -WorkingDirectory $RepoRoot

    Register-ScheduledTask `
        -TaskName $task.Name `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description $task.Description `
        -Force | Out-Null

    Write-Output "Installed scheduled task: $($task.Name)"
}
