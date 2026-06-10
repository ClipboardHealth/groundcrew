#!/usr/bin/env node
/**
 * Generates static/groundcrew-emoji.gif and static/groundcrew-avatar.png
 * from static/groundcrew-mark.svg (the taxiway sign tile).
 *
 * The mark is static, so the GIF is a single frame; both outputs are
 * rasterized from the same SVG source so the geometry lives in one place.
 *
 * Requires: macOS sips (built-in), ffmpeg
 * Usage:    npx tsx scripts/generateEmoji.mts
 */

import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const EMOJI_SIZE = 128; // Slack emoji max
const AVATAR_SIZE = 512; // Slack bot avatar
const MARK_PATH = "static/groundcrew-mark.svg";

// Rasterize the mark at a given pixel size by overriding the SVG's intrinsic
// width/height (sips renders at intrinsic size).
function rasterize(tmpDir: string, size: number, outPng: string): void {
  const svg = readFileSync(MARK_PATH, "utf8").replace(
    'width="120" height="120"',
    `width="${size}" height="${size}"`,
  );
  const svgPath = path.join(tmpDir, `mark-${size}.svg`);
  writeFileSync(svgPath, svg);

  const r = spawnSync("sips", ["-s", "format", "png", svgPath, "--out", outPng], {
    stdio: "inherit",
  });

  if (r.status !== 0) {
    process.stderr.write(`sips failed rasterizing ${outPng}\n`);
    process.exit(1);
  }
}

const tmpDir = path.join(tmpdir(), "groundcrew-emoji");
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir);

process.stdout.write("Generating static PNG avatar...\n");
rasterize(tmpDir, AVATAR_SIZE, "static/groundcrew-avatar.png");

process.stdout.write("Generating emoji GIF...\n");
const emojiPng = path.join(tmpDir, "emoji.png");
rasterize(tmpDir, EMOJI_SIZE, emojiPng);

// Single-frame GIF; palettegen with reserve_transparent keeps alpha.
execSync(
  `ffmpeg -y -i "${emojiPng}" -vf "split[s0][s1];[s0]palettegen=reserve_transparent=1[p];[s1][p]paletteuse=alpha_threshold=128" "static/groundcrew-emoji.gif"`,
  { stdio: "inherit" },
);

rmSync(tmpDir, { recursive: true, force: true });

process.stdout.write(
  "\n  static/groundcrew-emoji.gif   — 128×128 GIF         (upload as Slack emoji)\n",
);
process.stdout.write(
  "  static/groundcrew-avatar.png  — 512×512 static PNG  (upload as bot avatar)\n",
);
