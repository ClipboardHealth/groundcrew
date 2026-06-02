# cspell:ignore noprofile norc ttyd

Output static/demo.gif
Require bash
Require ffmpeg
Require tmux
Require ttyd

Set Shell "bash"
Set Width 1320
# 690px ≈ 28 terminal rows. The right column splits into two stacked agent panes
# of ~13 content rows each, sized to hold the demo-fixture.sh agent script's
# 12-line output without scrolling (a scrolling pane makes its top border drift).
# Grow this if that output grows past ~13 lines.
Set Height 690
Set FontSize 16
Set FontFamily "Menlo"
Set Padding 16
Set Margin 40
Set MarginFill "#0a0a0b"
Set WindowBar Colorful
Set BorderRadius 12
Set TypingSpeed 35ms
Set CursorBlink false
Set Theme '{ "background": "#18181b", "foreground": "#e4e4e7", "cursor": "#77d94e", "selection": "#3f3f46", "black": "#27272a", "red": "#fb7185", "green": "#77d94e", "yellow": "#fbbf24", "blue": "#60a5fa", "magenta": "#c084fc", "cyan": "#34d399", "white": "#e4e4e7", "brightBlack": "#52525b", "brightRed": "#fda4af", "brightGreen": "#a3e635", "brightYellow": "#fcd34d", "brightBlue": "#93c5fd", "brightMagenta": "#d8b4fe", "brightCyan": "#6ee7b7", "brightWhite": "#fafafa" }'

Hide
Type "tmux -f /dev/null -L groundcrew-demo kill-session -t groundcrew 2>/dev/null || true"
Enter
Type "tmux -f /dev/null -L groundcrew-demo new-session -s groundcrew -- /bin/bash --noprofile --norc"
Enter
Type "source static/demo-fixture.sh"
Enter
Type "clear"
Enter
Show

Sleep 1.0
Type "crew run --watch"
Sleep 0.4
Enter
# ~8s of action, then hold the settled layout long enough to read all three panes.
Sleep 15

Hide
Type "tmux -f /dev/null -L groundcrew-demo kill-session -t groundcrew"
Enter
