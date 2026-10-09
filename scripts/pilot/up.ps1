# Starts Postgres (if it is not accepting connections) and then the whole pilot. Safe to run twice.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\pilot\up.ps1
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pgBin = Join-Path $root ".local-infra\postgres\pgsql\bin"
$pgData = Join-Path $root ".local-infra\pgdata"
$ready = & (Join-Path $pgBin "pg_isready.exe") -h 127.0.0.1 -p 5432
if ($LASTEXITCODE -ne 0) {
  Write-Output "postgres: starting"
  # Detached, because pg_ctl keeps its output handles open and would block this script.
  Start-Process -FilePath (Join-Path $pgBin "pg_ctl.exe") -ArgumentList "-D `"$pgData`" -l `"$(Join-Path $root '.local-infra\pg.log')`" start" -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    & (Join-Path $pgBin "pg_isready.exe") -h 127.0.0.1 -p 5432 | Out-Null
    if ($LASTEXITCODE -eq 0) { break }
  }
} else { Write-Output "postgres: already accepting connections" }
& (Join-Path $PSScriptRoot "start.ps1")
