[CmdletBinding()]
param(
    # SSH target of the Linux server. Defaults to TASK_SYNC_SSH_TARGET from .env.
    [string]$Server,
    # Checkout location on the server, relative to the remote home directory.
    [string]$RemoteDir = "projects/School-Dashboard",
    # Copy this laptop's run history, activity, class directions, settings, and saved problem
    # visuals to the server (refused if the server already has run history, unless -Force).
    [switch]$MigrateData,
    [switch]$Force
)

# Deploys this working tree to the Linux dashboard server over SSH, installs or updates its
# systemd user service, and points this laptop's worker settings at it. Key-based SSH login to
# the server must already work (it does if the Task Sync tunnel works).

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "dotenv.ps1")

$projectRoot = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $projectRoot ".env"
$tar = Join-Path $env:SystemRoot "System32\tar.exe"

function Invoke-Remote {
    param([Parameter(Mandatory)][string]$Command)
    $output = & ssh -o BatchMode=yes $Server $Command
    if ($LASTEXITCODE -ne 0) { throw "Remote command failed ($LASTEXITCODE): $Command" }
    return ($output | Out-String).Trim()
}

function Send-File {
    param([Parameter(Mandatory)][string]$LocalPath, [Parameter(Mandatory)][string]$RemotePath)
    & scp -q -o BatchMode=yes $LocalPath "${Server}:$RemotePath"
    if ($LASTEXITCODE -ne 0) { throw "Could not copy $LocalPath to ${Server}:$RemotePath" }
}

$taskSyncTarget = Get-DotEnvValue -Path $envPath -Key "TASK_SYNC_SSH_TARGET"
if (-not $Server) { $Server = $taskSyncTarget }
if (-not $Server) { throw "Pass -Server user@host, for example -Server daniel@latitude7370." }
$remotePort = Get-DotEnvValue -Path $envPath -Key "TASK_SYNC_REMOTE_PORT"
if (-not $remotePort) { $remotePort = "8790" }
# When Task Sync's backend runs on the dashboard server itself, the server reaches it directly.
$taskSyncOnServer = $taskSyncTarget -and $taskSyncTarget -eq $Server
$serverTaskSyncApiBase = if ($taskSyncOnServer) {
    "http://127.0.0.1:$remotePort/api/v1"
} else {
    Get-DotEnvValue -Path $envPath -Key "TASK_SYNC_API_BASE"
}
Write-Host "Deploying to ${Server}:~/$RemoteDir"

$staging = Join-Path ([System.IO.Path]::GetTempPath()) ("school-dashboard-deploy-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
    # 1. Source: tracked and untracked files that .gitignore does not exclude (never .env or data).
    $files = @(git -C $projectRoot ls-files --cached --others --exclude-standard) |
        Where-Object { Test-Path -LiteralPath (Join-Path $projectRoot $_) -PathType Leaf }
    $listPath = Join-Path $staging "files.txt"
    [System.IO.File]::WriteAllLines($listPath, [string[]]$files, (New-Object System.Text.UTF8Encoding($false)))
    $sourceArchive = Join-Path $staging "source.tgz"
    & $tar -czf $sourceArchive -C $projectRoot -T $listPath
    if ($LASTEXITCODE -ne 0) { throw "Could not package the working tree." }
    Invoke-Remote "mkdir -p ~/$RemoteDir" | Out-Null
    Send-File $sourceArchive "/tmp/school-dashboard-source.tgz"
    Invoke-Remote "tar -xzf /tmp/school-dashboard-source.tgz -C ~/$RemoteDir && rm -f /tmp/school-dashboard-source.tgz" | Out-Null
    Write-Host "Uploaded $($files.Count) files."

    # 2. Server .env: created once from this laptop's Canvas settings; never overwritten.
    if ((Invoke-Remote "test -f ~/$RemoteDir/.env && echo yes || echo no") -ne "yes") {
        $serverEnv = @(
            "CANVAS_API_TOKEN=$(Get-DotEnvValue -Path $envPath -Key 'CANVAS_API_TOKEN')"
            "CANVAS_BASE_URL=$(Get-DotEnvValue -Path $envPath -Key 'CANVAS_BASE_URL')"
            "SCHOOL_DASHBOARD_PORT=8892"
            "SCHOOL_DASHBOARD_HOST=0.0.0.0"
            "SCHOOL_DASHBOARD_AGENT_EXECUTION=worker"
            "SCHOOL_DASHBOARD_WORKER_TOKEN=$(New-WorkerToken)"
            "SCHOOL_DASHBOARD_CACHE_TTL_MINUTES=30"
            "SCHOOL_DASHBOARD_CACHE_MAX_MB=512"
        )
        $serverEnv += "TASK_SYNC_API_BASE=$serverTaskSyncApiBase"
        if ($taskSyncTarget -and -not $taskSyncOnServer) {
            $serverEnv += "TASK_SYNC_SSH_TARGET=$taskSyncTarget"
            $serverEnv += "TASK_SYNC_REMOTE_PORT=$remotePort"
        }
        $envFile = Join-Path $staging "server.env"
        # LF endings: the server's shell tooling would otherwise read every value with a trailing CR.
        [System.IO.File]::WriteAllText($envFile, (($serverEnv -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
        Invoke-Remote "umask 077 && touch ~/$RemoteDir/.env" | Out-Null
        Send-File $envFile "$RemoteDir/.env"
        Remove-Item -LiteralPath $envFile -Force
        Invoke-Remote "chmod 600 ~/$RemoteDir/.env" | Out-Null
        Write-Host "Created the server .env (Canvas credentials copied from this laptop; new worker token)."
    }

    # 3. Optional one-time data migration, before the service (re)starts on it.
    if ($MigrateData) {
        $hasRuns = Invoke-Remote "test -s ~/$RemoteDir/.school-dashboard/runs.json && echo yes || echo no"
        if ($hasRuns -eq "yes" -and -not $Force) {
            throw "The server already has run history. Rerun with -MigrateData -Force to replace it."
        }
        $dataRoot = Join-Path $projectRoot ".school-dashboard"
        $dataStaging = Join-Path $staging "data"
        New-Item -ItemType Directory -Path $dataStaging | Out-Null
        foreach ($name in @("runs.json", "activity.json", "course-directions.json")) {
            $source = Join-Path $dataRoot $name
            if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination $dataStaging }
        }
        $settingsSource = Join-Path $dataRoot "settings.json"
        if (Test-Path -LiteralPath $settingsSource -PathType Leaf) {
            # The saved Task Sync URL is this laptop's view; the server reaches Task Sync its own way.
            $saved = Get-Content -LiteralPath $settingsSource -Raw | ConvertFrom-Json
            $saved.connections.taskSyncApiBase = $serverTaskSyncApiBase
            [System.IO.File]::WriteAllText((Join-Path $dataStaging "settings.json"), ($saved | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
        }
        $assets = Join-Path $dataRoot "workspace-assets"
        if (Test-Path -LiteralPath $assets -PathType Container) { Copy-Item -LiteralPath $assets -Destination $dataStaging -Recurse }
        $dataArchive = Join-Path $staging "data.tgz"
        & $tar -czf $dataArchive -C $dataStaging .
        if ($LASTEXITCODE -ne 0) { throw "Could not package dashboard data." }
        Invoke-Remote "systemctl --user stop school-dashboard.service 2>/dev/null; mkdir -p ~/$RemoteDir/.school-dashboard" | Out-Null
        Send-File $dataArchive "/tmp/school-dashboard-data.tgz"
        Invoke-Remote "tar -xzf /tmp/school-dashboard-data.tgz -C ~/$RemoteDir/.school-dashboard && rm -f /tmp/school-dashboard-data.tgz" | Out-Null
        Write-Host "Migrated run history, activity, class directions, settings, and saved visuals."
    }

    # 4. Install dependencies, build, and (re)start the systemd user service on the server.
    & ssh -o BatchMode=yes $Server "bash ~/$RemoteDir/scripts/linux/install-server.sh"
    if ($LASTEXITCODE -ne 0) { throw "The server install script failed." }

    # 5. Point this laptop's worker at the server.
    $hostName = Invoke-Remote "hostname"
    $port = Invoke-Remote "sed -n 's/^SCHOOL_DASHBOARD_PORT=//p' ~/$RemoteDir/.env | tail -n 1"
    if (-not $port) { $port = "8892" }
    $token = Invoke-Remote "sed -n 's/^SCHOOL_DASHBOARD_WORKER_TOKEN=//p' ~/$RemoteDir/.env | tail -n 1"
    Set-DotEnvValue -Path $envPath -Key "SCHOOL_DASHBOARD_SERVER_URL" -Value "http://${hostName}:$port"
    Set-DotEnvValue -Path $envPath -Key "SCHOOL_DASHBOARD_WORKER_TOKEN" -Value $token
    Write-Host ""
    Write-Host "Dashboard: http://${hostName}:$port/  (reachable from your tailnet)"
    Write-Host "This laptop's .env now points its worker there. Start the worker with:"
    Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\install-windows-worker.ps1"
}
finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
