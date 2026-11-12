# A real Claude Code session with boss mode, recorded by record.ps1 into raw/demo.mp4.
# The waiting parts are cut and sped up afterwards.
Output demo.mp4

Set Shell "pwsh"
Set FontSize 16
Set Width 1400
Set Height 820
Set Padding 20
Set Framerate 10
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set WindowBar Colorful

Hide
Type "$env:HOME = $env:USERPROFILE = 'C:\qb-demo'; $env:TEMP = $env:TMP = 'C:\qb-demo\tmp'; function prompt { '$ ' }; Set-Location C:\qb-demo\todo-cli; Clear-Host"
Enter
Sleep 1s
Type "claude --permission-mode auto"
Enter
Sleep 12s
Show

Type "/boss on"
Sleep 500ms
Enter
Sleep 25s
Type "/clear"
Sleep 500ms
Enter
Sleep 5s

Type "Turn this into a proper todo app: due dates (`add --due YYYY-MM-DD`), priorities (`--priority high|normal|low`), `list` sorted by priority then due date with overdue items marked, `done <id>` and `remove <id>`, and `list --json`. Existing todos.json files must keep working. Add thorough tests, including the error cases."
Sleep 1s
Enter
Sleep 16m

Hide
Type "/exit"
Enter
Sleep 3s
