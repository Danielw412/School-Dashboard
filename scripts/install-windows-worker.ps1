[CmdletBinding()]
param(
    # The dashboard server this laptop dials out to over Tailscale, e.g. http://latitude7370:8892
    [string]$ServerUrl,
    # Must equal SCHOOL_DASHBOARD_WORKER_TOKEN in the server's .env.
    [string]$WorkerToken,
    # Leave the old all-in-one "Homework Dashboard Web" task installed instead of replacing it.
    [switch]$KeepLocalDashboard,
    # Remove the worker's scheduled task and stop it.
    [switch]$Uninstall
)

# Installs the School Dashboard laptop agent worker as a hidden per-user scheduled task that
# starts at sign-in. The worker keeps an outbound WebSocket to the dashboard server and runs
# Codex here, against this laptop's own ~/.codex; the dashboard itself lives on the server.

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dotenv.ps1")

$taskName = "Homework Dashboard Agent Worker"
$legacyTaskName = "Homework Dashboard Web"
$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
$wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
$tsxCliPath = Join-Path $projectRoot "node_modules\tsx\dist\cli.mjs"
$workerEntryPath = Join-Path $projectRoot "server\windows-worker-startup.ts"
$legacyEntryPath = Join-Path $projectRoot "server\windows-startup.ts"
$windowlessLauncherPath = Join-Path $projectRoot "scripts\windows-startup.vbs"
$logPath = Join-Path $projectRoot ".school-dashboard\agent-worker.log"
$principalUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$shortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "Homework Dashboard.url"

if ($Uninstall) {
    Stop-ScheduledTaskAndWait -TaskName $taskName
    Stop-ProjectNodeProcess -EntryPath $workerEntryPath
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    Write-Host "The laptop agent worker no longer starts automatically. Laptop agents show as unavailable on the dashboard; switch Run agents on to Server to keep using agents."
    return
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) { throw "Node.js was not found on PATH." }
$nodePath = $nodeCommand.Source
foreach ($required in @($wscriptPath, $tsxCliPath, $workerEntryPath, $windowlessLauncherPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required file not found: $required. Run npm install in $projectRoot."
    }
}

if ($ServerUrl) { Set-DotEnvValue -Path $envPath -Key "SCHOOL_DASHBOARD_SERVER_URL" -Value $ServerUrl.TrimEnd("/") }
if ($WorkerToken) { Set-DotEnvValue -Path $envPath -Key "SCHOOL_DASHBOARD_WORKER_TOKEN" -Value $WorkerToken }
$serverUrl = (Get-DotEnvValue -Path $envPath -Key "SCHOOL_DASHBOARD_SERVER_URL").TrimEnd("/")
if (-not $serverUrl) { throw "Pass -ServerUrl http://latitude7370:8892 (or set SCHOOL_DASHBOARD_SERVER_URL in .env)." }
if (-not (Get-DotEnvValue -Path $envPath -Key "SCHOOL_DASHBOARD_WORKER_TOKEN")) {
    throw "Pass -WorkerToken with the server's SCHOOL_DASHBOARD_WORKER_TOKEN (or set it in .env)."
}

try {
    $serverState = Invoke-RestMethod -Uri "$serverUrl/api/active-work" -TimeoutSec 15
}
catch {
    throw "Could not reach the dashboard server at $serverUrl. Check that Tailscale is connected and the school-dashboard service is running there. $($_.Exception.Message)"
}
if ($serverState.agents.mode -ne "worker") {
    Write-Warning "The server at $serverUrl is not in worker mode; set SCHOOL_DASHBOARD_AGENT_EXECUTION=worker in its .env."
}

# The dashboard now lives on the server, so the old all-in-one local server task is replaced.
if (-not $KeepLocalDashboard -and (Get-ScheduledTask -TaskName $legacyTaskName -ErrorAction SilentlyContinue)) {
    Stop-ScheduledTaskAndWait -TaskName $legacyTaskName
    Stop-ProjectNodeProcess -EntryPath $legacyEntryPath
    Unregister-ScheduledTask -TaskName $legacyTaskName -Confirm:$false
    Write-Host "Removed the old local dashboard task '$legacyTaskName'; the dashboard is served from $serverUrl."
}

Stop-ScheduledTaskAndWait -TaskName $taskName
Stop-ProjectNodeProcess -EntryPath $workerEntryPath
New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null

$actionArguments = '"{0}" "{1}" "{2}" "{3}" "{4}"' -f $windowlessLauncherPath, $nodePath, $tsxCliPath, $workerEntryPath, $logPath
$action = New-ScheduledTaskAction -Execute $wscriptPath -Argument $actionArguments -WorkingDirectory $projectRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $principalUser
$principal = New-ScheduledTaskPrincipal -UserId $principalUser -LogonType Interactive -RunLevel Limited
# The worker reconnects on its own after sleep or network changes; restarts cover crashes.
$settings = New-ScheduledTaskSettingsSet `
    -Hidden `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Runs School Dashboard agent jobs from $serverUrl with this laptop's Codex." `
    -Force | Out-Null

[System.IO.File]::WriteAllLines($shortcutPath, @(
    "[InternetShortcut]"
    "URL=$serverUrl/"
    "IconFile=$env:SystemRoot\System32\SHELL32.dll"
    "IconIndex=220"
))

Start-ScheduledTask -TaskName $taskName
$connected = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    Start-Sleep -Seconds 1
    try {
        $agents = (Invoke-RestMethod -Uri "$serverUrl/api/active-work" -TimeoutSec 5).agents
        if ($agents.available -and $agents.worker.hostname -eq $env:COMPUTERNAME) {
            $connected = $true
            break
        }
    }
    catch {
        # The server may be briefly unreachable while the worker starts.
    }
}
if (-not $connected) {
    throw "The worker task was installed but did not connect to $serverUrl within a minute. See $logPath."
}

Write-Host "Laptop agent worker installed: $taskName (starts at sign-in, hidden)."
Write-Host "Connected to $serverUrl as $env:COMPUTERNAME; agents are available on the dashboard."
Write-Host "Desktop shortcut: $shortcutPath -> $serverUrl/"
Write-Host "Worker log: $logPath"
