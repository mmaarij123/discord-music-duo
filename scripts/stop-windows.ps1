param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$entries = @((Join-Path $project 'src\run.js'), (Join-Path $project 'src\index.js'))
$pattern = '(?i)(?:^|[\s"])(?:' + (($entries | ForEach-Object { [regex]::Escape($_.Replace('/', '\')) }) -join '|') + ')(?=$|[\s"])'

try {
    $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\') -match $pattern })
    if (-not $running.Count) { Write-Host 'Music Bot is already stopped.'; exit 0 }
    if ($CheckOnly) { Write-Host "Found $($running.Count) running Music Bot instance(s). No process was stopped."; exit 0 }

    $roots = @($running | Where-Object { $_.ParentProcessId -notin $running.ProcessId })
    foreach ($bot in $roots) {
        # Recheck identity immediately before stopping a process tree. Never use
        # taskkill /IM node.exe: other applications may be using Node too.
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($bot.ProcessId)"
        if (-not $current) { continue }
        if ($current.CreationDate -ne $bot.CreationDate -or $current.Name -ne 'node.exe' -or -not $current.CommandLine -or -not ($current.CommandLine.Replace('/', '\') -match $pattern)) {
            throw 'The process identity changed. Run the stop launcher again.'
        }
        $killer = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\taskkill.exe') -ArgumentList @('/PID', [string]$bot.ProcessId, '/T', '/F') -WindowStyle Hidden -Wait -PassThru
        $remaining = Get-CimInstance Win32_Process -Filter "ProcessId=$($bot.ProcessId)"
        if ($remaining -and $remaining.CreationDate -eq $bot.CreationDate) { throw "The bot could not be stopped (exit code $($killer.ExitCode))." }
    }
    Write-Host 'Music Bot stopped. Its audio/extractor child processes were closed too.'
} catch {
    Write-Host ('Could not stop Music Bot: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
exit 0
