const assert = require("node:assert/strict");
const test = require("node:test");
const { KEY_SIZE, frameToKeyDataUri, scaleFrame } = require("../src/plugin/scale.js");
const { decodePng, encodePng } = require("../src/plugin/png.js");

function solid(width, height, [r, g, b, a = 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) data.set([r, g, b, a], index * 4);
  return { width, height, data };
}

function pixel(image, x, y) {
  const offset = (y * image.width + x) * 4;
  return [...image.data.subarray(offset, offset + 4)];
}

/** Source pixel a 64x64 emote frame stores at a given key coordinate. */
function sourceAt(keyX, keyY, { size = KEY_SIZE, scale = 3, sourceSize = 64 } = {}) {
  const offset = Math.floor((size - sourceSize * scale) / 2);
  return [Math.floor((keyX - offset) / scale), Math.floor((keyY - offset) / scale)];
}

test("a 64x64 frame renders at 3x inside a 196x196 black key canvas", () => {
  const key = scaleFrame(solid(64, 64, [255, 0, 0]));
  assert.equal(key.width, KEY_SIZE);
  assert.equal(key.height, KEY_SIZE);
  assert.deepEqual(pixel(key, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixel(key, 1, 1), [0, 0, 0, 255]);
  assert.deepEqual(pixel(key, 2, 2), [255, 0, 0, 255]);
  assert.deepEqual(pixel(key, 193, 193), [255, 0, 0, 255]);
  assert.deepEqual(pixel(key, 194, 194), [0, 0, 0, 255]);
  assert.deepEqual(pixel(key, 195, 195), [0, 0, 0, 255]);
});

test("every key pixel maps to its nearest source pixel", () => {
  const source = {
    width: 64,
    height: 64,
    data: Uint8Array.from({ length: 64 * 64 * 4 }, (_, index) => {
      const channel = index % 4;
      if (channel === 0) return Math.floor(index / 4) % 64;
      if (channel === 1) return Math.floor(Math.floor(index / 4) / 64);
      return channel === 2 ? 7 : 255;
    }),
  };
  const key = scaleFrame(source);
  for (const [x, y] of [[2, 2], [4, 5], [50, 121], [120, 60], [193, 193]]) {
    const [sourceX, sourceY] = sourceAt(x, y);
    assert.deepEqual(pixel(key, x, y).slice(0, 3), [sourceX % 64, sourceY, 7], `key(${x},${y})`);
  }
});

test("transparent source pixels composite over the canvas colour", () => {
  const transparent = scaleFrame(solid(64, 64, [255, 0, 0, 0]));
  assert.deepEqual(pixel(transparent, 96, 96), [0, 0, 0, 255]);

  const half = scaleFrame(solid(64, 64, [255, 0, 0, 128]));
  assert.deepEqual(pixel(half, 96, 96), [128, 0, 0, 255]);

  const gray = scaleFrame(solid(64, 64, [255, 0, 0, 0]), { background: [64, 64, 64] });
  assert.deepEqual(pixel(gray, 96, 96), [64, 64, 64, 255]);
});

test("background transparency 100 leaves the canvas margins fully transparent", () => {
  const transparent = scaleFrame(solid(64, 64, [255, 0, 0]), { background: [10, 20, 30], backgroundAlpha: 0 });
  assert.deepEqual(pixel(transparent, 0, 0), [10, 20, 30, 0]);
});

test("background transparency 0 keeps the canvas margins opaque", () => {
  const opaque = scaleFrame(solid(64, 64, [255, 0, 0]), { background: [10, 20, 30], backgroundAlpha: 1 });
  assert.deepEqual(pixel(opaque, 0, 0), [10, 20, 30, 255]);
});

test("partial background transparency composites the source over the background (source-over)", () => {
  // Fully transparent source pixel over a half-transparent background keeps the background colour
  // at half alpha.
  const clear = scaleFrame(solid(64, 64, [255, 0, 0, 0]), { background: [0, 0, 255], backgroundAlpha: 0.5 });
  assert.deepEqual(pixel(clear, 0, 0), [0, 0, 255, 128]);

  // Half-transparent red source over half-transparent blue background, stretched across the key:
  // outA = 128/255 + 0.5 * (1 - 128/255) = 0.751 -> 192; R = 255*sa/outA -> 170; B = 255*bgA*(1-sa)/outA -> 85.
  const half = scaleFrame(solid(64, 64, [255, 0, 0, 128]), { mode: "fill", background: [0, 0, 255], backgroundAlpha: 0.5 });
  assert.deepEqual(pixel(half, 100, 100), [170, 0, 85, 192]);

  // The same source over a fully opaque background matches the previous default compositing.
  const overOpaque = scaleFrame(solid(64, 64, [255, 0, 0, 128]), { mode: "fill", background: [0, 0, 255] });
  assert.deepEqual(pixel(overOpaque, 100, 100), [128, 0, 127, 255]);
});

test("opaque source pixels never fade, whatever the background transparency", () => {
  const key = scaleFrame(solid(64, 64, [255, 0, 0]), { mode: "fill", background: [0, 255, 0], backgroundAlpha: 0.5 });
  assert.deepEqual(pixel(key, 100, 100), [255, 0, 0, 255]);
});

test("invalid background alpha options are rejected", () => {
  assert.throws(() => scaleFrame(solid(64, 64, [0, 0, 0]), { backgroundAlpha: 1.5 }), /background alpha/);
  assert.throws(() => scaleFrame(solid(64, 64, [0, 0, 0]), { backgroundAlpha: -0.1 }), /background alpha/);
  assert.throws(() => scaleFrame(solid(64, 64, [0, 0, 0]), { backgroundAlpha: "0.5" }), /background alpha/);
});

test("fill mode stretches the frame across the whole key", () => {
  const source = solid(64, 64, [0, 0, 255]);
  source.data.set([255, 255, 255, 255], 0);
  source.data.set([1, 2, 3, 255], (63 * 64 + 63) * 4);
  const key = scaleFrame(source, { mode: "fill" });
  assert.deepEqual(pixel(key, 0, 0), [255, 255, 255, 255]);
  assert.deepEqual(pixel(key, 195, 195), [1, 2, 3, 255]);
  assert.deepEqual(pixel(key, 100, 100), [0, 0, 255, 255]);
});

test("non-square frames keep their aspect ratio in pixel mode", () => {
  const key = scaleFrame(solid(48, 40, [10, 20, 30]));
  assert.deepEqual(pixel(key, 0, 0), [0, 0, 0, 255]);
  assert.deepEqual(pixel(key, 2, 18), [10, 20, 30, 255]);
  assert.deepEqual(pixel(key, 193, 177), [10, 20, 30, 255]);
  assert.deepEqual(pixel(key, 195, 195), [0, 0, 0, 255]);
});

test("a frame larger than the key is downscaled to fit", () => {
  const key = scaleFrame(solid(300, 300, [5, 6, 7]));
  assert.deepEqual(pixel(key, 0, 0), [5, 6, 7, 255]);
  assert.deepEqual(pixel(key, 195, 195), [5, 6, 7, 255]);
});

/** Builds a small frame where each pixel asks `paint(x, y)` for its RGBA colour. */
function painted(width, height, paint) {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) data.set(paint(x, y), (y * width + x) * 4);
  return { width, height, data };
}

function blackRingWithRedCenter(x, y) {
  return x >= 2 && x <= 3 && y >= 2 && y <= 3 ? [255, 0, 0, 255] : [0, 0, 0, 255];
}

test("edge-connected exact black is removed and shows the configured background", () => {
  const key = scaleFrame(painted(6, 6, blackRingWithRedCenter), {
    mode: "fill",
    background: [10, 20, 30],
    removeBlackBackground: true,
  });
  assert.deepEqual(pixel(key, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(pixel(key, 33, 33), [10, 20, 30, 255]);
  assert.deepEqual(pixel(key, 100, 100), [255, 0, 0, 255]);
});

test("the removal also applies in pixel mode", () => {
  const key = scaleFrame(painted(64, 64, blackRingWithRedCenter), {
    background: [10, 20, 30],
    removeBlackBackground: true,
  });
  // The 2px letterbox and the removed source ring both carry the configured background.
  assert.deepEqual(pixel(key, 0, 0), [10, 20, 30, 255]);
  assert.deepEqual(pixel(key, 5, 5), [10, 20, 30, 255]);
  // key(9,9) maps to source pixel (2,2), the red centre.
  assert.deepEqual(pixel(key, 9, 9), [255, 0, 0, 255]);
});

test("enclosed black details survive the removal", () => {
  const source = painted(8, 8, (x, y) => (x >= 3 && x <= 4 && y >= 3 && y <= 4 ? [0, 0, 0, 255] : [255, 0, 0, 255]));
  const key = scaleFrame(source, { mode: "fill", removeBlackBackground: true });
  assert.deepEqual(pixel(key, 10, 10), [255, 0, 0, 255]);
  assert.deepEqual(pixel(key, 100, 100), [0, 0, 0, 255]);
});

test("near-black pixels are never removed", () => {
  const key = scaleFrame(painted(4, 4, () => [1, 1, 1, 255]), {
    mode: "fill",
    background: [10, 20, 30],
    removeBlackBackground: true,
  });
  assert.deepEqual(pixel(key, 0, 0), [1, 1, 1, 255]);
  assert.deepEqual(pixel(key, 195, 195), [1, 1, 1, 255]);
});

test("nonblack foreground pixels are untouched and the source frame is never mutated", () => {
  const source = painted(4, 4, (x, y) => (x === 0 || y === 0 || x === 3 || y === 3 ? [0, 0, 0, 255] : [255, 0, 0, 255]));
  const snapshot = new Uint8Array(source.data);
  const key = scaleFrame(source, {
    mode: "fill",
    background: [10, 20, 30],
    backgroundAlpha: 0,
    removeBlackBackground: true,
  });
  assert.deepEqual([...source.data], [...snapshot]);
  // Removed pixels show the fully transparent background; opaque red never fades.
  assert.deepEqual(pixel(key, 0, 0), [10, 20, 30, 0]);
  assert.deepEqual(pixel(key, 100, 100), [255, 0, 0, 255]);
});

test("a full-black image becomes the configured background at its transparency", () => {
  const key = scaleFrame(painted(4, 4, () => [0, 0, 0, 255]), {
    mode: "fill",
    background: [10, 20, 30],
    backgroundAlpha: 0,
    removeBlackBackground: true,
  });
  assert.deepEqual(pixel(key, 0, 0), [10, 20, 30, 0]);
  assert.deepEqual(pixel(key, 195, 195), [10, 20, 30, 0]);
});

test("transparent edge pixels are traversed to reach black behind them, without being modified", () => {
  const source = painted(6, 6, (x, y) => {
    if (x === 0 || y === 0 || x === 5 || y === 5) return [255, 0, 0, 0]; // transparent ring
    if (x === 1 || y === 1 || x === 4 || y === 4) return [0, 0, 0, 255]; // black ring behind it
    return [255, 0, 0, 255]; // red centre
  });
  const key = scaleFrame(source, {
    mode: "fill",
    background: [10, 20, 30],
    backgroundAlpha: 0.5,
    removeBlackBackground: true,
  });
  // The black ring is not on the edge but connects through the transparent pixels: removed.
  assert.deepEqual(pixel(key, 33, 33), [10, 20, 30, 128]);
  // The red centre survives.
  assert.deepEqual(pixel(key, 80, 80), [255, 0, 0, 255]);
});

test("without the option the key keeps the legacy opaque black result", () => {
  const source = painted(6, 6, blackRingWithRedCenter);
  for (const options of [{ mode: "fill", background: [10, 20, 30] }, { mode: "fill", removeBlackBackground: false }]) {
    const key = scaleFrame(source, options);
    assert.deepEqual(pixel(key, 0, 0), [0, 0, 0, 255]);
    assert.deepEqual(pixel(key, 100, 100), [255, 0, 0, 255]);
  }
});

test("invalid removal option values are safely ignored instead of removing everything", () => {
  const source = painted(6, 6, blackRingWithRedCenter);
  for (const value of ["yes", 1, "TRUE", null, undefined]) {
    const key = scaleFrame(source, { mode: "fill", removeBlackBackground: value });
    assert.deepEqual(pixel(key, 0, 0), [0, 0, 0, 255], `value ${String(value)}`);
  }
});

test("invalid scale options are rejected", () => {
  assert.throws(() => scaleFrame(solid(64, 64, [0, 0, 0]), { mode: "bicubic" }), /scale mode/);
  assert.throws(() => scaleFrame(solid(64, 64, [0, 0, 0]), { size: 0 }), /key size/);
  assert.throws(() => scaleFrame({ width: 0, height: 0, data: new Uint8Array(0) }), /frame size/);
});

test("a received PNG becomes a 196x196 key data URI", () => {
  const uri = frameToKeyDataUri(encodePng(solid(64, 64, [12, 34, 56])));
  assert.match(uri, /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
  const decoded = decodePng(Buffer.from(uri.split(",")[1], "base64"));
  assert.equal(decoded.width, KEY_SIZE);
  assert.equal(decoded.height, KEY_SIZE);
  assert.deepEqual(pixel(decoded, 96, 96), [12, 34, 56, 255]);
});
