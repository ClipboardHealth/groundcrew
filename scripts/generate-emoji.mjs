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
 * Usage:    node scripts/generate-emoji.mjs
 */

import { execSync, spawnSync } from 'child_process';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ─── Config ──────────────────────────────────────────────────────────────────

const FRAMES = 12;       // per 2.4s cycle — 200ms/frame, smooth at emoji size
const DURATION = 2.4;    // seconds, must match SVG animation duration
const OFFSET = 0.5;      // right wand phase offset as fraction of cycle
const EMOJI_SIZE = 128;  // Slack emoji max
const AVATAR_SIZE = 512; // Slack bot avatar

// ─── Colors ──────────────────────────────────────────────────────────────────

// Background is transparent — GIF uses 1-bit alpha; works at small emoji sizes.
const FULL = [0xff, 0x6d, 0x00]; // #FF6D00 wand at full brightness
const DIM_OPACITY = 0.38;         // minimum opacity from animation keyframes

function hex(rgb) {
  return '#' + rgb.map((c) => c.toString(16).padStart(2, '0')).join('');
}

// Composite FULL over white at opacity t → used to derive a "dimmed" solid color
// for GIF frames (no partial transparency needed in the mark itself).
function compositeOverWhite(t) {
  return FULL.map((c) => Math.round(c * t + 0xff * (1 - t)));
}

// ─── Animation ───────────────────────────────────────────────────────────────

// Standard ease-in-out (close enough to CSS cubic-bezier(0.42,0,0.58,1))
function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

// Opacity for wand at animation phase [0,1].
// Keyframes: 0%→1.0, 25%→DIM, 50%→1.0, 50–100%→1.0 (held bright)
function wandOpacity(phase) {
  if (phase < 0.25) return 1 + (DIM_OPACITY - 1) * easeInOut(phase / 0.25);
  if (phase < 0.5) return DIM_OPACITY + (1 - DIM_OPACITY) * easeInOut((phase - 0.25) / 0.25);
  return 1;
}

// ─── SVG frame ───────────────────────────────────────────────────────────────

function makeSvgFrame(colorL, colorR, size) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="${size}" height="${size}">
  <line x1="18" y1="108" x2="88" y2="11" stroke="${hex(colorL)}" stroke-width="20" stroke-linecap="round"/>
  <line x1="102" y1="108" x2="32" y2="11" stroke="${hex(colorR)}" stroke-width="20" stroke-linecap="round"/>
</svg>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const tmpDir = join(tmpdir(), 'groundcrew-emoji');
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir);

console.log(`Generating ${FRAMES} frames...`);

for (let i = 0; i < FRAMES; i++) {
  const t = (i / FRAMES) * DURATION;
  const phaseL = t / DURATION;
  const phaseR = ((t / DURATION) + OFFSET) % 1;

  const colorL = compositeOverWhite(wandOpacity(phaseL));
  const colorR = compositeOverWhite(wandOpacity(phaseR));

  const svgPath = join(tmpDir, `frame-${i.toString().padStart(3, '0')}.svg`);
  const pngPath = join(tmpDir, `frame-${i.toString().padStart(3, '0')}.png`);

  writeFileSync(svgPath, makeSvgFrame(colorL, colorR, EMOJI_SIZE));

  const r = spawnSync('sips', ['-s', 'format', 'png', svgPath, '--out', pngPath], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    console.error(`sips failed on frame ${i}:`, r.stderr);
    process.exit(1);
  }
  process.stdout.write(`  ${i + 1}/${FRAMES}\r`);
}

// ─── Animated GIF ────────────────────────────────────────────────────────────

console.log('\nAssembling animated GIF...');
const fps = (FRAMES / DURATION).toFixed(4);

// Two-pass palettegen for best color fidelity at small GIF palette size.
// reserve_transparent keeps the GIF alpha channel.
execSync(
  `ffmpeg -y -framerate ${fps} -i "${tmpDir}/frame-%03d.png" ` +
    `-vf "split[s0][s1];[s0]palettegen=reserve_transparent=1[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:alpha_threshold=128" ` +
    `-loop 0 "static/groundcrew-emoji.gif"`,
  { stdio: 'inherit' },
);

// ─── Static PNG avatar ────────────────────────────────────────────────────────

console.log('Generating static PNG avatar...');
const avatarSvg = makeSvgFrame(FULL, FULL, AVATAR_SIZE);
const avatarSvgPath = join(tmpDir, 'avatar.svg');
writeFileSync(avatarSvgPath, avatarSvg);
spawnSync('sips', ['-s', 'format', 'png', avatarSvgPath, '--out', 'static/groundcrew-avatar.png'], {
  stdio: 'inherit',
});

rmSync(tmpDir, { recursive: true, force: true });

console.log('');
console.log('  static/groundcrew-emoji.gif   — 128×128 animated GIF  (upload as Slack emoji)');
console.log('  static/groundcrew-avatar.png  — 512×512 static PNG    (upload as bot avatar)');
