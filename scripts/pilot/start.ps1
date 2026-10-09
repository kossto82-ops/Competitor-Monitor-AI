# Starts everything the pricing pilot needs, detached from any terminal, and records the process ids.
# Safe to run twice: anything already running is left alone.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pilot\start.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dir = Join-Path $root ".local-infra\pilot"
New-Item -ItemType Directory -Force $dir | Out-Null

# Only the variables the processes need. In particular NOT CMA_ALLOW_PRIVATE_TARGETS (the pilot reads public
# websites, so the SSRF guard must stay fully on) and no AI key (monitoring never calls an AI provider).
$wanted = "DATABASE_URL", "REDIS_URL", "AUTH_SECRET", "CMA_AI_ENCRYPTION_KEY"
Get-Content (Join-Path $root ".env") | ForEach-Object {
  if ($_ -match '^([A-Z_]+)=(.*)$' -and $wanted -contains $Matches[1]) {
    [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"'), "Process")
  }
}

function Test-Alive($name) {
  $pidFile = Join-Path $dir "$name.pid"
  if (-not (Test-Path $pidFile)) { return $false }
  $p = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
  # After a reboot Windows reuses process ids: a pid file may now point at an unrelated program.
  return [bool]$p -and (@("node", "powershell", "pwsh", "redis-server") -contains $p.ProcessName)
}

function Start-Detached($name, $file, $arguments, $workDir) {
  if (Test-Alive $name) { Write-Output "$name already running (pid $(Get-Content (Join-Path $dir "$name.pid")))"; return }
  $p = Start-Process -FilePath $file -ArgumentList $arguments -WorkingDirectory $workDir -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $dir "$name.out.log") -RedirectStandardError (Join-Path $dir "$name.err.log")
  Set-Content -Path (Join-Path $dir "$name.pid") -Value $p.Id
  Write-Output "$name started (pid $($p.Id))"
}

# Redis: bound to the loopback interface only (the job queue must never be reachable from the network).
$redisListening = Get-NetTCPConnection -State Listen -LocalPort 6379 -ErrorAction SilentlyContinue
if (-not $redisListening) {
  $redis = Join-Path $root ".local-infra\redis\Redis-7.4.11-Windows-x64-msys2\redis-server.exe"
  Start-Detached "redis" $redis "--bind 127.0.0.1 --port 6379 --save `"`" --appendonly no" (Split-Path $redis)
  Start-Sleep -Seconds 2
} else { Write-Output "redis already listening on 6379" }

Start-Detached "worker" "node" "dist/index.js" (Join-Path $root "apps\worker")
Start-Detached "scheduler" "node" "dist/scheduler.js" (Join-Path $root "apps\worker")
# Asks Windows not to go to sleep while it runs (the same request a video player makes). It changes no
# setting and ends with its process; it cannot keep the laptop awake if the lid is closed.
Start-Detached "keepawake" "powershell" "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\keepawake.ps1`"" $root
