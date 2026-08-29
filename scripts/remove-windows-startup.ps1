[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$taskName = "Homework Dashboard Web"
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    if ($task.State -eq "Running") {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 250
            $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        } while ($null -ne $task -and $task.State -eq "Running" -and [DateTime]::UtcNow -lt $stopDeadline)

        if ($null -ne $task -and $task.State -eq "Running") {
            throw "The scheduled task '$taskName' could not be stopped and was not removed."
        }
    }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$shortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Homework Dashboard.url"
if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
    Remove-Item -LiteralPath $shortcutPath -Force
}

Write-Host "Homework Dashboard no longer starts automatically."
