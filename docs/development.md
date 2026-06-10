# Development

Clone the repo and run the CLI from TypeScript source:

```bash
cd ~/dev/c/groundcrew
node --run crew -- doctor

# With 1Password for GROUNDCREW_LINEAR_API_KEY:
node --run crew:op -- run --watch
```

Both forms discover config through cosmiconfig. Source edits in `src/**` are picked up on the next invocation. Requires Node >= 24.

Regenerate the README demo with VHS:

```bash
./static/render-demo.sh
```

Regenerate the Slack bot avatar (also used as the emoji upload; Slack scales it down) after editing the mark:

```bash
sed 's/width="120" height="120"/width="512" height="512"/' static/groundcrew-mark.svg > /tmp/mark512.svg
sips -s format png /tmp/mark512.svg --out static/groundcrew-avatar.png
```
