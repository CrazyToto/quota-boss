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
  # WhatsApp falls back to a small thumbnail for larger files; the 211 KB light version showed small, 74 KB shows large.
  # Reduce to a 256-colour palette with Pillow when it is available.
  $py = 'from PIL import Image; import sys; p=sys.argv[1]; Image.open(p).convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(p, optimize=True)'
  if (Get-Command python -ErrorAction SilentlyContinue) { python -c $py $out 2>$null }
  if ((Get-Item $out).Length -gt 150KB) { Write-Warning 'Image is over 150 KB; WhatsApp may show only a small preview. Install Pillow (pip install pillow) and render again.' }
  Write-Output ("Wrote $out ({0:N0} KB)" -f ((Get-Item $out).Length / 1KB))
} finally { Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue }
