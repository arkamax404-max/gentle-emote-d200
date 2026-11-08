import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { encodePng } = require("../src/plugin/png.js");
const { scaleFrame } = require("../src/plugin/scale.js");

const PLUGIN = "com.arkamax404.ulanzi.gentleemote.ulanziPlugin";
const source = new URL("../src/plugin/", import.meta.url);
const output = new URL(`../${PLUGIN}/dist/`, import.meta.url);
const assets = new URL(`../${PLUGIN}/assets/`, import.meta.url);

rmSync(output, { force: true, recursive: true });
mkdirSync(output, { recursive: true });
mkdirSync(assets, { recursive: true });
cpSync(source, output, { recursive: true });

const icon = createIconPng();
writeFileSync(fileURLToPath(new URL("plugin.png", assets)), icon);
writeFileSync(fileURLToPath(new URL("action.png", assets)), icon);
console.log(`Copied the plugin runtime to ${fileURLToPath(output)} and wrote the key icons.`);

/** A 64x64 pixel-art Gentleman, rendered through the same 3x key scaler the runtime uses. */
function createIconPng() {
  const width = 64;
  const height = 64;
  const data = new Uint8Array(width * height * 4);
  const paint = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const offset = (y * width + x) * 4;
    data[offset] = r;
    data[offset + 1] = g;
    data[offset + 2] = b;
    data[offset + 3] = 255;
  };
  const rect = (x, y, w, h, color) => {
    for (let row = y; row < y + h; row += 1) for (let column = x; column < x + w; column += 1) paint(column, row, color);
  };

  const canvas = [11, 15, 20];
  const frame = [240, 192, 64];
  const skin = [127, 214, 163];
  const shadow = [82, 168, 122];
  const ink = [11, 15, 20];

  rect(0, 0, width, height, canvas);
  // Pixel frame, inset by one pixel so the 3x upscale keeps a clean edge.
  rect(1, 1, width - 2, 1, frame);
  rect(1, height - 2, width - 2, 1, frame);
  rect(1, 1, 1, height - 2, frame);
  rect(width - 2, 1, 1, height - 2, frame);

  // Head with a shaded right side, two eyes and a smile.
  rect(18, 14, 28, 30, skin);
  rect(40, 14, 6, 30, shadow);
  rect(24, 26, 5, 6, ink);
  rect(35, 26, 5, 6, ink);
  rect(27, 36, 10, 2, ink);
  rect(25, 35, 2, 2, ink);
  rect(37, 35, 2, 2, ink);
  // Accent collar under the head.
  rect(22, 46, 20, 3, frame);

  return encodePng(scaleFrame({ width, height, data }));
}
