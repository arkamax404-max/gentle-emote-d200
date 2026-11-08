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

function assertFrame(image) {
  if (!image || typeof image !== "object") throw new Error("invalid frame image");
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error("invalid frame size");
  if (!data || data.length !== width * height * 4) throw new Error("invalid frame pixels");
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
  const source = image.data;
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
        data[destination + 3] = 255;
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
      for (let channel = 0; channel < 3; channel += 1)
        data[destination + channel] = Math.round(source[origin + channel] * alpha + background[channel] * (1 - alpha));
      data[destination + 3] = 255;
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

module.exports = { KEY_SIZE, SCALE_MODES, fitFrame, frameToKeyDataUri, frameToKeyPng, scaleFrame };
