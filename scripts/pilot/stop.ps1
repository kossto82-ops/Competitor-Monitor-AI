# Stops the pilot's own processes (worker, scheduler, keep-awake). Redis and Postgres are left running.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pilot\stop.ps1
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$dir = Join-Path $root ".local-infra\pilot"
foreach ($name in "scheduler", "worker", "keepawake") {
  $pidFile = Join-Path $dir "$name.pid"
  if (Test-Path $pidFile) {
    $p = Get-Process -Id ([int](Get-Content $pidFile)) -ErrorAction SilentlyContinue
    # Never stop a process that only reuses the recorded pid (it may be an unrelated program after a reboot).
    if ($p -and @("node", "powershell", "pwsh") -contains $p.ProcessName) { Stop-Process -Id $p.Id -Force; Write-Output "$name stopped (pid $($p.Id))" } else { Write-Output "$name was not running" }
    Remove-Item $pidFile
  }
}
