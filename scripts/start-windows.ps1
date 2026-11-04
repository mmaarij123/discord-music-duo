param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$entry = Join-Path $project 'src\run.js'
$mutex = $null
$ownsMutex = $false
$result = 1

try {
    Set-Location -LiteralPath $project
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'The bot files are missing. Keep this launcher inside the Music Bot folder.' }
    if (-not (Test-Path -LiteralPath (Join-Path $project 'node_modules\discord.js\package.json') -PathType Leaf)) { throw 'Dependencies are missing. Open this folder in a terminal and run npm ci first.' }
    foreach ($profile in @('bot1', 'bot2')) {
        if (-not (Test-Path -LiteralPath (Join-Path $project ".env.$profile") -PathType Leaf)) { throw "Missing .env.$profile. Both bot profiles are required." }
    }

    $nodes = @()
    $installedNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($installedNode) { $nodes += $installedNode.Source }
    $nodes += Join-Path $project '..\..\work\runtime\node_modules\node\bin\node.exe'
    $node = $null
    foreach ($candidate in $nodes) {
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        $version = & $candidate -p 'process.versions.node'
        if ($LASTEXITCODE -eq 0 -and $version -match '^(\d+)\.(\d+)\.(\d+)$') {
            if ([int]$Matches[1] -gt 24 -or ([int]$Matches[1] -eq 24 -and [int]$Matches[2] -ge 17)) {
                $node = (Resolve-Path -LiteralPath $candidate).Path
                break
            }
        }
    }
    if (-not $node) { throw 'Install Node.js 24.17.0 or newer, then reopen this launcher.' }

    & $node $entry --check
    if ($LASTEXITCODE -ne 0) { throw 'The bot profiles could not be loaded.' }
    if ($CheckOnly) { Write-Host "Launcher checks passed (Node $version)."; exit 0 }

    # Serialize double-clicks; the process check also recognizes the running bot
    # started through this wrapper or the previous direct entry point.
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($project.ToLowerInvariant()))).Replace('-', '') }
    finally { $sha.Dispose() }
    $mutex = New-Object System.Threading.Mutex($false, "Local\MusicBot-$key")
    try { $ownsMutex = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $ownsMutex = $true }
    $entries = @($entry, (Join-Path $project 'src\index.js'))
    $pattern = '(?i)(?:^|[\s"])(?:' + (($entries | ForEach-Object { [regex]::Escape($_.Replace('/', '\')) }) -join '|') + ')(?=$|[\s"])'
    $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Replace('/', '\') -match $pattern })
    if (-not $ownsMutex -or $running.Count -gt 0) {
        Write-Host 'Music Bots are already running. Stop them before starting a new session.'
        $result = 0
    } else {
        Write-Host "Starting both Music Bots (Node $version)..."
        Write-Host 'Keep this window open. Press Ctrl+C to stop both bots.'
        & $node $entry
        $result = $LASTEXITCODE
        Write-Host "Music Bot stopped (exit code $result)."
    }
} catch {
    Write-Host ('Could not start Music Bot: ' + $_.Exception.Message) -ForegroundColor Red
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
exit $result
