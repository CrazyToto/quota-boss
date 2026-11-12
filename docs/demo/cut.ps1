# Cuts raw/demo.mp4 (from record.ps1) into docs/assets/demo.gif: reading parts at normal speed, waiting parts sped up and labelled.
# The times belong to one take; after a new recording, look at the raw video and adjust $Segments.
#   pwsh docs/demo/cut.ps1
param([string]$In = (Join-Path $PSScriptRoot 'raw\demo.mp4'), [string]$Out = (Join-Path $PSScriptRoot '..\assets\demo.gif'),
  [int]$Width = 1400, [int]$Fps = 10, [int]$HoldEnd = 8)
$ErrorActionPreference = 'Stop'

# start, end (seconds in the raw video), speed
$Segments = @(
  @(0, 14, 2),     # /boss on runs
  @(14, 19, 1),    # its result
  @(25, 45, 1),    # /clear and the task
  @(45, 87, 3),    # the boss reads the project and writes the spec
  @(87, 95, 1),    # the handoff to Codex
  @(95, 225, 25),  # Codex works
  @(225, 255, 3),  # the boss checks the result, runs the tests and logs the result
  @(255, 262, 1)   # the summary
)

$font = 'C\:/Windows/Fonts/consola.ttf'
$parts = @(); $labels = @()
for ($i = 0; $i -lt $Segments.Count; $i++) {
  $a, $b, $s = $Segments[$i]
  $f = "[0:v]trim=start=${a}:end=${b},setpts=(PTS-STARTPTS)/$s,fps=$Fps"
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
