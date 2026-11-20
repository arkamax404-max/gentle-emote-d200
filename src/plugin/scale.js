"use strict";

// Renders a received emote frame on the D200 key pixel grid.
// The D200 key canvas is 196x196, so a 64x64 frame gets an exact 3x nearest-neighbour
// upscale (192x192) centred with a 2px letterbox. Integer scaling keeps pixel-art
// edges crisp, which any fractional stretch would destroy.
const { decodePng, encodePng } = require("./png.js");

const KEY_SIZE = 196;
const SCALE_MODES = Object.freeze(["pixel", "fill"]);

function normalizeBackground(value) {
  if (value === undefined) return [0, 0, 0];
  if (!Array.isArray(value) || value.length !== 3) throw new Error("invalid canvas background");
  for (const channel of value)
    if (!Number.isInteger(channel) || channel < 0 || channel > 255) throw new Error("invalid canvas background");
  return value;
}

/** Background alpha behind the frame: 1 (default) keeps today's opaque canvas, 0 is fully transparent. */
function normalizeBackgroundAlpha(value) {
  if (value === undefined) return 1;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
    throw new Error("invalid background alpha");
  return value;
}

function assertFrame(image) {
  if (!image || typeof image !== "object") throw new Error("invalid frame image");
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error("invalid frame size");
  if (!data || data.length !== width * height * 4) throw new Error("invalid frame pixels");
}

/** Only a genuine `true` (or the string form a host may echo back) turns the removal on. */
function wantsBlackRemoval(value) {
  return value === true || value === "true";
}

/**
 * Clears the alpha of every exact RGB(0,0,0) pixel connected to the source edges, using an
 * explicit stack (no recursion) and 4-neighbour connectivity. Fully transparent pixels are
 * traversed so black behind them is reached, but they are never modified; enclosed black
 * details stay untouched. Returns a copy — the source frame data is never mutated.
 */
function removeEdgeConnectedBlack(image) {
  const { width, height } = image;
  const data = new Uint8Array(image.data);
  const visited = new Uint8Array(width * height);
  const stack = [];
  const visit = (index) => {
    if (visited[index]) return;
    visited[index] = 1;
    const offset = index * 4;
    const black = data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 0;
    const transparent = data[offset + 3] === 0;
    if (!black && !transparent) return;
    if (black) data[offset + 3] = 0;
    stack.push(index);
  };
  for (let x = 0; x < width; x += 1) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  while (stack.length > 0) {
    const index = stack.pop();
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) visit(index - 1);
    if (x < width - 1) visit(index + 1);
    if (y > 0) visit(index - width);
    if (y < height - 1) visit(index + width);
  }
  return data;
}

/** Geometry of one drawn frame inside the key canvas, in source-pixel space. */
function fitFrame(width, height, size) {
  const longest = Math.max(width, height);
  let drawnWidth;
  let drawnHeight;
  if (longest > size) {
    // Larger-than-key sources must fit: proportional nearest-neighbour downscale.
    drawnWidth = Math.max(1, Math.round((width * size) / longest));
    drawnHeight = Math.max(1, Math.round((height * size) / longest));
  } else {
    // Integer factor so source pixels stay square and identical in size.
    const factor = Math.max(1, Math.floor(size / longest));
    drawnWidth = width * factor;
    drawnHeight = height * factor;
  }
  return {
    drawnWidth,
    drawnHeight,
    left: Math.floor((size - drawnWidth) / 2),
    top: Math.floor((size - drawnHeight) / 2),
  };
}

/**
 * Scales a decoded frame to a key-sized RGBA canvas.
 * `pixel` (default) keeps the source aspect ratio on an integer factor; `fill` stretches to the key.
 */
function scaleFrame(image, options = {}) {
  assertFrame(image);
  const mode = options.mode === undefined ? "pixel" : options.mode;
  if (!SCALE_MODES.includes(mode)) throw new Error(`invalid scale mode: ${mode}`);
  const size = options.size === undefined ? KEY_SIZE : options.size;
  if (!Number.isInteger(size) || size < 1) throw new Error(`invalid key size: ${size}`);
  const background = normalizeBackground(options.background);
  const backgroundAlpha = normalizeBackgroundAlpha(options.backgroundAlpha);
  const source = wantsBlackRemoval(options.removeBlackBackground)
    ? removeEdgeConnectedBlack(image)
    : image.data;
  const data = new Uint8Array(size * size * 4);
  const geometry =
    mode === "fill"
      ? { drawnWidth: size, drawnHeight: size, left: 0, top: 0 }
      : fitFrame(image.width, image.height, size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const destination = (y * size + x) * 4;
      const insideX = x >= geometry.left && x < geometry.left + geometry.drawnWidth;
      const insideY = y >= geometry.top && y < geometry.top + geometry.drawnHeight;
      if (!insideX || !insideY) {
        data[destination] = background[0];
        data[destination + 1] = background[1];
        data[destination + 2] = background[2];
        data[destination + 3] = Math.round(backgroundAlpha * 255);
        continue;
      }
      const sourceX = Math.min(
        image.width - 1,
        Math.floor(((x - geometry.left) * image.width) / geometry.drawnWidth),
      );
      const sourceY = Math.min(
        image.height - 1,
        Math.floor(((y - geometry.top) * image.height) / geometry.drawnHeight),
      );
      const origin = (sourceY * image.width + sourceX) * 4;
      const alpha = source[origin + 3] / 255;
      // Source-over with the background: an opaque source pixel never fades, while a transparent
      // or partially transparent one lets the background (and its alpha) through.
      const coverage = backgroundAlpha * (1 - alpha);
      const outAlpha = alpha + coverage;
      for (let channel = 0; channel < 3; channel += 1)
        data[destination + channel] = outAlpha === 0
          ? background[channel]
          : Math.round((source[origin + channel] * alpha + background[channel] * coverage) / outAlpha);
      data[destination + 3] = Math.round(outAlpha * 255);
    }
  }
  return { width: size, height: size, data };
}

/** Decodes a received PNG and re-encodes it for the key. */
function frameToKeyPng(buffer, options) {
  return encodePng(scaleFrame(decodePng(buffer), options));
}

/** Decodes a received PNG into the `data:image/png;base64,` URI the key accepts. */
function frameToKeyDataUri(buffer, options) {
  return `data:image/png;base64,${frameToKeyPng(buffer, options).toString("base64")}`;
}

module.exports = {
  KEY_SIZE,
  SCALE_MODES,
  fitFrame,
  frameToKeyDataUri,
  frameToKeyPng,
  removeEdgeConnectedBlack,
  scaleFrame,
};
