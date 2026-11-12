# Cuts raw/demo.mp4 (from record.ps1) into docs/assets/demo.gif: the handoff and the summary at normal speed, waiting parts sped up and labelled.
# The times belong to one take; after a new recording, look at the raw video and adjust $Segments.
#   pwsh docs/demo/cut.ps1
param([string]$In = (Join-Path $PSScriptRoot 'raw\demo.mp4'), [string]$Out = (Join-Path $PSScriptRoot '..\assets\demo.gif'),
  [int]$Width = 1400, [int]$Fps = 10, [int]$HoldEnd = 6)
$ErrorActionPreference = 'Stop'

# start, end (seconds in the raw video), speed
# The take starts with /boss on and /clear; the cut starts at the task and leaves both out.
$Segments = @(
  @(30.5, 44, 2),   # the task is typed
  @(44, 86, 6),     # the boss reads the project and writes the spec
  @(87, 95, 1),     # the handoff to Codex
  @(95, 224, 40),   # Codex works
  @(226, 255, 4),   # the boss checks the result, runs the tests and logs the result
  @(255, 258.8, 1)  # the summary
)
# The "> /clear" line stays on screen after the cut start; these boxes paint it over (y, from, to in raw seconds).
$Masks = @(@(206, 0, 86.5), @(72, 86.5, 225.5))

$font = 'C\:/Windows/Fonts/consola.ttf'
$mask = ($Masks | ForEach-Object { "drawbox=x=0:y=$($_[0]):w=300:h=30:color=0x1e1e2e:t=fill:enable='between(t,$($_[1]),$($_[2]))'" }) -join ','
$parts = @("[0:v]$mask,split=$($Segments.Count)" + ((0..($Segments.Count - 1) | ForEach-Object { "[m$_]" }) -join '')); $labels = @()
for ($i = 0; $i -lt $Segments.Count; $i++) {
  $a, $b, $s = $Segments[$i]
  $f = "[m$i]trim=start=${a}:end=${b},setpts=(PTS-STARTPTS)/$s,fps=$Fps"
  if ($s -ne 1) {
    $f += ",drawtext=fontfile='$font':text='sped up ${s}x':fontsize=22:fontcolor=0x1e1e2e:box=1:boxcolor=0xf9e2af:boxborderw=8:x=w-tw-28:y=14"
  }
  $parts += "$f[v$i]"; $labels += "[v$i]"
}
$graph = ($parts -join ';') + ';' + ($labels -join '') + "concat=n=$($Segments.Count):v=1:a=0," +
  "tpad=stop_mode=clone:stop_duration=$HoldEnd,scale=${Width}:-1:flags=lanczos,split[x][y];" +
  '[x]palettegen=stats_mode=diff[p];[y][p]paletteuse=dither=none:diff_mode=rectangle'
ffmpeg -v error -y -i $In -filter_complex $graph $Out
if ($LASTEXITCODE) { throw "ffmpeg failed ($LASTEXITCODE)" }
Get-Item $Out | Select-Object Name, Length
