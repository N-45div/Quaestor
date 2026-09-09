#!/usr/bin/env node
"use strict";
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Generate the Open Graph card: the hero's wave field, 1200x630, as a PNG.
 *
 *   node scripts/make-og.js
 *
 * Written against node:zlib with no image dependency, because the repo has
 * none and adding sharp (a native build) or puppeteer (a browser) to render
 * one static image would be the most expensive dependency in the project.
 * A PNG is a signature, three chunks and a CRC — cheaper to write than to
 * install.
 *
 * Deliberately carries no text. X renders `summary_large_image` with og:title
 * and og:description beside the image, so baking words in would duplicate them
 * at a fixed size that cannot adapt — and rasterising type here would mean
 * shipping a font and a glyph renderer.
 */

const W = 1200;
const H = 630;

// Matches app/src/components/WaveField.tsx and the CSS tokens.
const BG = [0x0d, 0x0d, 0x0d];
const LAYERS = [
  { amp: 46, len: 0.0042, phase: 0.0, y: 0.42, w: 2.1, a: 0.9, rgb: [212, 168, 67] },
  { amp: 58, len: 0.0031, phase: 2.1, y: 0.49, w: 1.7, a: 0.6, rgb: [212, 168, 67] },
  { amp: 34, len: 0.0058, phase: 4.4, y: 0.56, w: 1.5, a: 0.45, rgb: [169, 129, 44] },
  { amp: 72, len: 0.0023, phase: 1.2, y: 0.63, w: 1.4, a: 0.3, rgb: [57, 135, 229] },
  { amp: 50, len: 0.0037, phase: 3.7, y: 0.71, w: 1.4, a: 0.24, rgb: [25, 158, 112] },
];

const waveY = (layer, x) =>
  H * layer.y +
  Math.sin(x * layer.len + layer.phase) * layer.amp +
  Math.sin(x * layer.len * 0.47 - layer.phase * 0.6) * layer.amp * 0.35;

function render() {
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    px[i * 3] = BG[0];
    px[i * 3 + 1] = BG[1];
    px[i * 3 + 2] = BG[2];
  }

  const put = (x, y, rgb, alpha) => {
    if (x < 0 || x >= W || y < 0 || y >= H || alpha <= 0) return;
    const i = (y * W + x) * 3;
    const a = Math.min(alpha, 1);
    px[i] = Math.round(px[i] * (1 - a) + rgb[0] * a);
    px[i + 1] = Math.round(px[i + 1] * (1 - a) + rgb[1] * a);
    px[i + 2] = Math.round(px[i + 2] * (1 - a) + rgb[2] * a);
  };

  for (const layer of LAYERS) {
    for (let x = 0; x < W; x++) {
      // Fade both ends so the lines emerge from the dark rather than being cut
      // off by the frame.
      const edge = Math.min(x / (W * 0.22), (W - x) / (W * 0.22), 1);
      const y = waveY(layer, x);
      const half = layer.w;
      const lo = Math.floor(y - half - 1.5);
      const hi = Math.ceil(y + half + 1.5);
      for (let yy = lo; yy <= hi; yy++) {
        // Distance-to-curve falloff: cheap antialiasing, and the soft shoulder
        // reads as a glow rather than a hard 1px stroke.
        const d = Math.abs(yy - y);
        const core = d <= half ? 1 : Math.max(0, 1 - (d - half) / 1.5);
        put(x, yy, layer.rgb, core * layer.a * edge * 0.95);
      }
    }
  }

  // A low gold wash under the waves, so the lower half has weight.
  for (let y = Math.floor(H * 0.32); y < H; y++) {
    const t = (y - H * 0.32) / (H * 0.68);
    const a = 0.05 * (1 - Math.abs(t - 0.45) * 1.6);
    if (a <= 0) continue;
    for (let x = 0; x < W; x++) put(x, y, [212, 168, 67], a);
  }

  // Hairline frame, the same 1px gold rule the site uses.
  for (let x = 0; x < W; x++) {
    put(x, 0, [212, 168, 67], 0.5);
    put(x, H - 1, [212, 168, 67], 0.5);
  }
  for (let y = 0; y < H; y++) {
    put(0, y, [212, 168, 67], 0.5);
    put(W - 1, y, [212, 168, 67], 0.5);
  }

  return px;
}

// ---- minimal PNG writer -------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // Every scanline is prefixed with its filter byte; 0 = None. Filtering would
  // shrink this further, but the image is already well under any size limit.
  const raw = Buffer.alloc(H * (W * 3 + 1));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    pixels.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
  }

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, "..", "app", "public", "og.png");
const buf = png(render());
fs.writeFileSync(out, buf);
console.log(`wrote ${out} — ${W}x${H}, ${(buf.length / 1024).toFixed(1)} kB`);
