# Renders docs/social/preview.html to docs/assets/social-preview.png (1280x640) with headless Edge or Chrome.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$html = Join-Path $PSScriptRoot 'preview.html'
$out = Join-Path $root 'docs\assets\social-preview.png'
$browser = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'Edge or Chrome not found.' }
$profileDir = Join-Path ([IO.Path]::GetTempPath()) ('qb-social-' + [guid]::NewGuid())
try {
  $url = 'file:///' + ($html -replace '\\', '/')
  & $browser --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1280,640 `
    "--user-data-dir=$profileDir" "--screenshot=$out" $url | Out-Null
  if (-not (Test-Path $out)) { throw 'Screenshot was not written.' }
  Write-Output ("Wrote $out ({0:N0} KB)" -f ((Get-Item $out).Length / 1KB))
} finally { Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue }
