# Small .env helpers shared by the Windows setup scripts (dot-source this file).

function Get-DotEnvValue {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Key)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return "" }
    $value = ""
    foreach ($line in [System.IO.File]::ReadAllLines($Path)) {
        if ($line -match "^$([regex]::Escape($Key))=(.*)$") { $value = $Matches[1].Trim() }
    }
    return $value
}

function Set-DotEnvValue {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Key, [string]$Value)
    $lines = if (Test-Path -LiteralPath $Path -PathType Leaf) { @([System.IO.File]::ReadAllLines($Path)) } else { @() }
    $found = $false
    $updated = @(foreach ($line in $lines) {
        if ($line -match "^$([regex]::Escape($Key))=") {
            if (-not $found) { "$Key=$Value" }
            $found = $true
        }
        else {
            $line
        }
    })
    if (-not $found) { $updated += "$Key=$Value" }
    [System.IO.File]::WriteAllLines($Path, [string[]]$updated, (New-Object System.Text.UTF8Encoding($false)))
}

function New-WorkerToken {
    $bytes = New-Object byte[] 32
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Stop-ScheduledTaskAndWait {
    param([Parameter(Mandatory)][string]$TaskName)
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($null -eq $task -or $task.State -ne "Running") { return }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    } while ($null -ne $task -and $task.State -eq "Running" -and [DateTime]::UtcNow -lt $deadline)
    if ($null -ne $task -and $task.State -eq "Running") {
        throw "The scheduled task '$TaskName' could not be stopped."
    }
}

function Stop-ProjectNodeProcess {
    # Stops node.exe processes started from one of this project's entry points (by command line).
    param([Parameter(Mandatory)][string]$EntryPath)
    $marker = $EntryPath.ToLowerInvariant()
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -in @("node.exe", "node") -and ([string]$_.CommandLine).ToLowerInvariant().Contains($marker)
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
