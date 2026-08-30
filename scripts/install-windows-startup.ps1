[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$taskName = "Homework Dashboard Web"
$websiteUrl = "http://127.0.0.1:8780/"
$port = 8780
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
$distIndexPath = Join-Path $projectRoot "dist\index.html"
$tsxCliPath = Join-Path $projectRoot "node_modules\tsx\dist\cli.mjs"
$startupModulePath = Join-Path $projectRoot "server\windows-startup.ts"
$windowlessLauncherPath = Join-Path $projectRoot "scripts\windows-startup.vbs"
$logDirectory = Join-Path $projectRoot ".school-dashboard"
$logPath = Join-Path $logDirectory "web-startup.log"
$principalUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

if ($null -eq $nodeCommand) {
    throw "Node.js was not found on PATH. Install Node.js before installing Homework Dashboard startup."
}

$nodePath = $nodeCommand.Source
if (-not (Test-Path -LiteralPath $wscriptPath -PathType Leaf)) {
    throw "The Windows Script Host executable was not found at $wscriptPath"
}

if (-not (Test-Path -LiteralPath $tsxCliPath -PathType Leaf)) {
    throw "The local tsx runtime was not found at $tsxCliPath. Run npm install in $projectRoot."
}

if (-not (Test-Path -LiteralPath $startupModulePath -PathType Leaf)) {
    throw "The Windows startup entry point was not found at $startupModulePath"
}

if (-not (Test-Path -LiteralPath $windowlessLauncherPath -PathType Leaf)) {
    throw "The windowless Windows startup launcher was not found at $windowlessLauncherPath"
}

if (-not (Test-Path -LiteralPath $distIndexPath -PathType Leaf)) {
    throw "The production dashboard was not found at $distIndexPath. Run npm run build first."
}

# Fail early with a useful installer error if Node cannot launch the local tsx runtime.
$tsxCheckOutput = & $nodePath $tsxCliPath "--version" 2>&1
if ($LASTEXITCODE -ne 0) {
    throw "The local tsx runtime could not be launched by $nodePath. Output: $tsxCheckOutput"
}

New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

# Stop the previous task before replacing it so a rerun cannot leave two servers competing for
# the loopback port. Register-ScheduledTask -Force then updates the task definition in place.
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    if ($existingTask.State -eq "Running") {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $stopDeadline = [DateTime]::UtcNow.AddSeconds(15)
        do {
            Start-Sleep -Milliseconds 250
            $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        } while ($null -ne $existingTask -and $existingTask.State -eq "Running" -and [DateTime]::UtcNow -lt $stopDeadline)

        if ($null -ne $existingTask -and $existingTask.State -eq "Running") {
            throw "The existing scheduled task '$taskName' could not be stopped before it was updated."
        }
    }
}

# A manually launched or previously detached startup process can outlive the scheduled-task
# action. Stop only this project's startup entry point before testing port readiness.
$startupMarker = $startupModulePath.ToLowerInvariant()
$staleServers = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $commandLine = ([string]$_.CommandLine).ToLowerInvariant()
        $_.Name -in @("node.exe", "node") -and $commandLine.Contains($startupMarker)
    }
)
foreach ($staleServer in $staleServers) {
    Stop-Process -Id $staleServer.ProcessId -Force -ErrorAction Stop
}

$portReleaseDeadline = [DateTime]::UtcNow.AddSeconds(15)
do {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        break
    }
    Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $portReleaseDeadline)

if ($listeners.Count -ne 0) {
    try {
        $dashboardApiUrl = "$($websiteUrl.TrimEnd('/'))/api/settings"
        $dashboardResponse = Invoke-WebRequest -Uri $dashboardApiUrl -UseBasicParsing -TimeoutSec 1
        $existingDashboard = $dashboardResponse.StatusCode -eq 200
    }
    catch {
        $existingDashboard = $false
    }

    if (-not $existingDashboard) {
        $owners = ($listeners | Select-Object -ExpandProperty OwningProcess -Unique) -join ", "
        throw "Port $port is still occupied after stopping this project's prior startup server. Owning process IDs: $owners"
    }
}
else {
    $existingDashboard = $false
}

$actionArguments = '"{0}" "{1}" "{2}" "{3}" "{4}"' -f $windowlessLauncherPath, $nodePath, $tsxCliPath, $startupModulePath, $logPath
$action = New-ScheduledTaskAction `
    -Execute $wscriptPath `
    -Argument $actionArguments `
    -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $principalUser
$principal = New-ScheduledTaskPrincipal `
    -UserId $principalUser `
    -LogonType Interactive `
    -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -Hidden `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Starts the private Homework Dashboard website in the background when this user signs in." `
    -Force | Out-Null

$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "Homework Dashboard.url"
$shortcutContents = @(
    "[InternetShortcut]"
    "URL=$websiteUrl"
    "IconFile=$env:SystemRoot\System32\SHELL32.dll"
    "IconIndex=220"
)
[System.IO.File]::WriteAllLines($shortcutPath, $shortcutContents)

if ($existingDashboard) {
    $ready = $true
    Write-Host "An existing Homework Dashboard server is already responding; leaving it in place."
    Write-Host "The scheduled task will start the dashboard automatically at the next sign-in."
}
else {
    Start-ScheduledTask -TaskName $taskName

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        $taskState = if ($null -ne $task) { [string]$task.State } else { "Missing" }
        try {
            $response = Invoke-WebRequest -Uri $websiteUrl -UseBasicParsing -TimeoutSec 1
            $activeListeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
            if ($response.StatusCode -eq 200 -and $taskState -eq "Running" -and $activeListeners.Count -gt 0) {
                $ready = $true
                break
            }
        }
        catch {
            # The task can take a few seconds to start while Node and tsx load.
        }
        Start-Sleep -Milliseconds 500
    }
}

if (-not $ready) {
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName -ErrorAction SilentlyContinue
    $taskState = if ($null -ne $task) { [string]$task.State } else { "Missing" }
    $lastResult = if ($null -ne $taskInfo) { [string]$taskInfo.LastTaskResult } else { "Unknown" }
    throw "Startup was installed, but the background task did not make $websiteUrl ready. Task state: $taskState. Last task result: $lastResult. See $logPath for startup diagnostics."
}

Write-Host "Windows startup task installed: $taskName"
Write-Host "The server runs windowlessly via wscript.exe and node.exe; no browser or terminal was opened."
Write-Host "Desktop shortcut created: $shortcutPath"
Write-Host "Website ready: $websiteUrl"
Write-Host "Startup log: $logPath"
