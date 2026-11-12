# Records a real Claude Code session with boss mode for the README demo (raw video; see demo.tape for the cut).
# Everything runs in a separate demo home with its own Claude login, so no personal paths appear.
# Codex keeps your normal login (CODEX_HOME), because it reads the profile folder from Windows, not from USERPROFILE.
#   pwsh docs/demo/record.ps1 -Login     once, in your own terminal: installs, logs in to Claude, trusts the demo project
#   pwsh docs/demo/record.ps1            records raw/demo.mp4 (spends a little real quota)
#   pwsh docs/demo/record.ps1 -Cleanup   deletes the demo home and its Claude login
# Needs vhs, ttyd and ffmpeg on PATH (winget install charmbracelet.vhs tsl0922.ttyd Gyan.FFmpeg).
param([switch]$Login, [switch]$Cleanup, [string]$DemoHome = 'C:\qb-demo',
  [string]$Tape = (Join-Path $PSScriptRoot 'demo.tape'), [string]$Out = (Join-Path $PSScriptRoot 'raw'))
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$project = Join-Path $DemoHome 'todo-cli'
if ($Cleanup) { if (Test-Path $DemoHome) { Remove-Item -Recurse -Force $DemoHome }; return }

function Use-DemoHome([scriptblock]$Body) {
  $names = 'HOME', 'USERPROFILE', 'TEMP', 'TMP'
  $saved = @{}; foreach ($n in $names) { $saved[$n] = [Environment]::GetEnvironmentVariable($n) }
  try {
    $env:HOME = $env:USERPROFILE = $DemoHome; $env:TEMP = $env:TMP = Join-Path $DemoHome 'tmp'
    & $Body
  } finally { foreach ($n in $names) { [Environment]::SetEnvironmentVariable($n, $saved[$n]) } }
}
function Reset-Project {
  if (Test-Path $project) { Remove-Item -Recurse -Force $project }
  Copy-Item -Recurse (Join-Path $PSScriptRoot 'todo-cli') $project
  git -C $project init -q
  git -C $project add -A
  git -C $project -c user.name=demo -c user.email=demo@example.invalid commit -q -m 'Start the todo list'
}

if (-not $env:CODEX_HOME) { $env:CODEX_HOME = Join-Path $HOME '.codex' }
# Run Claude Code as a fresh top-level session, not as a child of a session this script may be started from.
Get-ChildItem Env: | Where-Object { $_.Name -like 'CLAUDE*' } | Remove-Item
New-Item -ItemType Directory -Force -Path (Join-Path $DemoHome 'tmp') | Out-Null
Use-DemoHome { '' | node (Join-Path $repo 'install.js') | Out-Null }
Reset-Project

if ($Login) {
  Write-Host "Log in to Claude and trust the folder $project, then type /exit."
  Use-DemoHome { Push-Location $project; try { claude } finally { Pop-Location } }
  return
}

if (-not (Test-Path (Join-Path $DemoHome '.claude\.credentials.json'))) { throw "Run this script with -Login first." }
# VHS drives a headless browser through go-rod; its own lookup can fail on Windows, so name an installed one.
if (-not $env:rod) {
  $browser = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Google\Chrome\Application\chrome.exe") |
    Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($browser) { $env:rod = "bin=$browser" }
}
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Push-Location $Out
# The browser needs the real profile, so only the recorded shell switches to the demo home (see demo.tape).
try { vhs $Tape } finally { Pop-Location }
