const assert = require("node:assert/strict");
const test = require("node:test");
const { deflateSync } = require("node:zlib");
const { decodePng, encodePng } = require("../src/plugin/png.js");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

function ihdr(width, height, colorType) {
  const body = Buffer.alloc(13);
  body.writeUInt32BE(width, 0);
  body.writeUInt32BE(height, 4);
  body.set([8, colorType, 0, 0, 0], 8);
  return chunk("IHDR", body);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Builds a PNG whose scanlines deliberately use every filter type. */
function buildPng({ width, height, colorType, channels, rows, palette, transparency }) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  const previous = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = y % 5;
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x += 1) {
      const value = rows[y][x];
      const left = x >= channels ? rows[y][x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      const predictor =
        filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
      raw[y * (stride + 1) + 1 + x] = (value - predictor) & 0xff;
    }
    previous.set(rows[y]);
  }
  const parts = [SIGNATURE, ihdr(width, height, colorType)];
  if (palette) parts.push(chunk("PLTE", Buffer.from(palette)));
  if (transparency) parts.push(chunk("tRNS", Buffer.from(transparency)));
  parts.push(chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

test("encode then decode preserves every RGBA byte", () => {
  const width = 4;
  const height = 3;
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < data.length; index += 1) data[index] = (index * 37) % 256;
  const decoded = decodePng(encodePng({ width, height, data }));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(Buffer.from(decoded.data), Buffer.from(data));
});

test("encode writes an 8-bit RGBA non-interlaced PNG", () => {
  const png = encodePng({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, 4]) });
  assert.deepEqual(png.subarray(0, 8), SIGNATURE);
  assert.equal(png.toString("latin1", 12, 16), "IHDR");
  assert.deepEqual([...png.subarray(24, 29)], [8, 6, 0, 0, 0]);
  assert.equal(png.toString("latin1", png.length - 8, png.length - 4), "IEND");
});

test("decode handles every scanline filter on RGBA input", () => {
  const width = 3;
  const height = 5;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [];
    for (let x = 0; x < width; x += 1) row.push(y * 10 + x, 255 - y, 7, 255);
    rows.push(row);
  }
  const decoded = decodePng(buildPng({ width, height, colorType: 6, channels: 4, rows }));
  assert.deepEqual(rows.flat(), [...decoded.data]);
});

test("decode converts RGB, grayscale and grayscale-alpha to RGBA", () => {
  const rgb = decodePng(
    buildPng({ width: 2, height: 1, colorType: 2, channels: 3, rows: [[10, 20, 30, 40, 50, 60]] }),
  );
  assert.deepEqual([...rgb.data], [10, 20, 30, 255, 40, 50, 60, 255]);

  const gray = decodePng(buildPng({ width: 2, height: 1, colorType: 0, channels: 1, rows: [[9, 200]] }));
  assert.deepEqual([...gray.data], [9, 9, 9, 255, 200, 200, 200, 255]);

  const grayAlpha = decodePng(
    buildPng({ width: 1, height: 1, colorType: 4, channels: 2, rows: [[77, 128]] }),
  );
  assert.deepEqual([...grayAlpha.data], [77, 77, 77, 128]);
});

test("decode expands paletted PNGs with tRNS transparency", () => {
  const decoded = decodePng(
    buildPng({
      width: 3,
      height: 1,
      colorType: 3,
      channels: 1,
      rows: [[0, 1, 2]],
      palette: [255, 0, 0, 0, 255, 0, 0, 0, 255],
      transparency: [0, 255],
    }),
  );
  assert.deepEqual([...decoded.data], [255, 0, 0, 0, 0, 255, 0, 255, 0, 0, 255, 255]);
});

test("decode rejects non-PNG and unsupported PNG shapes", () => {
  assert.throws(() => decodePng(Buffer.from("not a png")), /not a PNG/);

  const sixteenBit = Buffer.concat([
    SIGNATURE,
    (() => {
      const body = Buffer.alloc(13);
      body.writeUInt32BE(1, 0);
      body.writeUInt32BE(1, 4);
      body.set([16, 6, 0, 0, 0], 8);
      return chunk("IHDR", body);
    })(),
    chunk("IDAT", deflateSync(Buffer.alloc(9))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  assert.throws(() => decodePng(sixteenBit), /unsupported PNG/);
});
