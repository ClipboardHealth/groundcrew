#!/usr/bin/env node
/**
 * Generates static/groundcrew-emoji.gif and static/groundcrew-avatar.png
 * from the logomark geometry.
 *
 * Instead of converting the animated SVG (which most tools render statically),
 * this script bakes the animation by interpolating wand colors per-frame and
 * rasterizing each frame individually.
 *
 * Requires: macOS sips (built-in), ffmpeg
 * Usage:    npx tsx scripts/generateEmoji.mts
 */

import { execSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ─── Config ───────────────────────────────────────────────────────────────────

const FRAMES = 12; // per 2.4s cycle — 200ms/frame, smooth at emoji size
const DURATION = 2.4; // seconds, must match SVG animation duration
const OFFSET = 0.5; // right wand phase offset as fraction of cycle
const EMOJI_SIZE = 128; // Slack emoji max
const AVATAR_SIZE = 512; // Slack bot avatar

// ─── Colors ───────────────────────────────────────────────────────────────────

// Transparent background — GIF uses 1-bit alpha; edges are fine at emoji sizes.
const FULL: [number, number, number] = [255, 109, 0]; // #FF6D00
const DIM_OPACITY = 0.38; // minimum opacity from animation keyframes

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

// Composite FULL over white at opacity t — derives a solid "dimmed" color
// so GIF frames need no partial transparency in the mark itself.
function compositeOverWhite(t: number): [number, number, number] {
  const [r, g, b] = FULL.map((c) => Math.round(c * t + 255 * (1 - t)));
  return [r ?? 0, g ?? 0, b ?? 0];
}

// ─── Animation ────────────────────────────────────────────────────────────────

// Standard ease-in-out (close enough to CSS cubic-bezier(0.42, 0, 0.58, 1))
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

// Opacity for wand at animation phase [0,1].
// Keyframes: 0%→1.0, 25%→DIM, 50%→1.0, 50–100%→1.0 (held bright)
function wandOpacity(phase: number): number {
  if (phase < 0.25) {
    return 1 + (DIM_OPACITY - 1) * easeInOut(phase / 0.25);
  }

  if (phase < 0.5) {
    return DIM_OPACITY + (1 - DIM_OPACITY) * easeInOut((phase - 0.25) / 0.25);
  }

  return 1;
}

// ─── SVG frame ────────────────────────────────────────────────────────────────

function makeSvgFrame(
  colorL: [number, number, number],
  colorR: [number, number, number],
  size: number,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">
  <line x1="18" y1="108" x2="88" y2="11" stroke="${toHex(colorL)}" stroke-width="20" stroke-linecap="round"/>
  <line x1="102" y1="108" x2="32" y2="11" stroke="${toHex(colorR)}" stroke-width="20" stroke-linecap="round"/>
</svg>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const tmpDir = path.join(tmpdir(), "groundcrew-emoji");
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir);

process.stdout.write(`Generating ${FRAMES} frames...\n`);

for (let i = 0; i < FRAMES; i++) {
  const t = (i / FRAMES) * DURATION;
  const phaseL = t / DURATION;
  const phaseR = (t / DURATION + OFFSET) % 1;

  const colorL = compositeOverWhite(wandOpacity(phaseL));
  const colorR = compositeOverWhite(wandOpacity(phaseR));

  const svgPath = path.join(tmpDir, `frame-${i.toString().padStart(3, "0")}.svg`);
  const pngPath = path.join(tmpDir, `frame-${i.toString().padStart(3, "0")}.png`);

  writeFileSync(svgPath, makeSvgFrame(colorL, colorR, EMOJI_SIZE));

  const r = spawnSync("sips", ["-s", "format", "png", svgPath, "--out", pngPath], {
    encoding: "utf8",
  });

  if (r.status !== 0) {
    process.stderr.write(`sips failed on frame ${i}: ${r.stderr}\n`);
    process.exit(1);
  }

  process.stdout.write(`  ${i + 1}/${FRAMES}\r`);
}

// ─── Animated GIF ─────────────────────────────────────────────────────────────

process.stdout.write("\nAssembling animated GIF...\n");
const fps = (FRAMES / DURATION).toFixed(4);

// Two-pass palettegen for best color fidelity; reserve_transparent keeps alpha.
execSync(
  `ffmpeg -y -framerate ${fps} -i "${tmpDir}/frame-%03d.png" -vf "split[s0][s1];[s0]palettegen=reserve_transparent=1[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:alpha_threshold=128" -loop 0 "static/groundcrew-emoji.gif"`,
  { stdio: "inherit" },
);

// ─── Static PNG avatar ────────────────────────────────────────────────────────

process.stdout.write("Generating static PNG avatar...\n");
const avatarSvg = makeSvgFrame(FULL, FULL, AVATAR_SIZE);
const avatarSvgPath = path.join(tmpDir, "avatar.svg");
writeFileSync(avatarSvgPath, avatarSvg);
spawnSync("sips", ["-s", "format", "png", avatarSvgPath, "--out", "static/groundcrew-avatar.png"], {
  stdio: "inherit",
});

rmSync(tmpDir, { recursive: true, force: true });

process.stdout.write(
  "\n  static/groundcrew-emoji.gif   — 128×128 animated GIF  (upload as Slack emoji)\n",
);
process.stdout.write(
  "  static/groundcrew-avatar.png  — 512×512 static PNG    (upload as bot avatar)\n",
);
