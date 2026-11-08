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
