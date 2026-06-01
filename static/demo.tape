# cspell:ignore noprofile norc ttyd

Output static/demo.gif
Require bash
Require ffmpeg
Require tmux
Require ttyd

Set Shell "bash"
Set Width 1200
Set Height 500
Set FontSize 16
Set FontFamily "Menlo"
Set Padding 0
Set Margin 24
Set MarginFill "#1479ff"
Set WindowBar Colorful
Set BorderRadius 10
Set TypingSpeed 35 ms
Set CursorBlink false

Hide
Type "tmux -f /dev/null -L groundcrew-demo kill-session -t groundcrew 2>/dev/null || true"
Enter
Type "tmux -f /dev/null -L groundcrew-demo new-session -s groundcrew -- /bin/bash --noprofile --norc"
Enter
Type "source static/demo-fixture.sh"
Enter
Ctrl+L
Show

Sleep 0.5
Type "crew run --watch"
Enter
Sleep 8

Hide
Type "tmux -L groundcrew-demo kill-session -t groundcrew"
Enter
