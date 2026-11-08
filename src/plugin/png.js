"use strict";

// PNG codec adapted from gentle-emote's src/png.ts (MIT, Santiago Pérez / Gentleman Programming).
// Only what a 64x64 emote frame needs: 8-bit, non-interlaced PNG in, RGBA out, RGBA in, PNG out.
const { deflateSync, inflateSync } = require("node:zlib");

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

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

/** Encodes an 8-bit RGBA image (row-major, 4 bytes per pixel) as a PNG buffer. */
function encodePng(image) {
  const { width, height, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
    throw new Error("invalid PNG dimensions");
  if (data.length !== width * height * 4) throw new Error("invalid PNG pixel data");
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decodes a PNG buffer into `{ width, height, data }` with 8-bit RGBA pixels. */
function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE))
    throw new Error("not a PNG");
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === "PLTE") palette = body;
    else if (type === "tRNS") transparency = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
  }
  const channels = CHANNELS[colorType];
  if (bitDepth !== 8 || interlace !== 0 || channels === undefined || width < 1 || height < 1)
    throw new Error(`unsupported PNG (depth=${bitDepth}, color=${colorType}, interlace=${interlace})`);
  if (idat.length === 0) throw new Error("unsupported PNG (no image data)");

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("truncated PNG image data");
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x];
      const left = x >= channels ? pixels[dst + x - channels] : 0;
      const up = y > 0 ? pixels[dst - stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[dst - stride + x - channels] : 0;
      let reconstructed;
      switch (filter) {
        case 0:
          reconstructed = value;
          break;
        case 1:
          reconstructed = value + left;
          break;
        case 2:
          reconstructed = value + up;
          break;
        case 3:
          reconstructed = value + ((left + up) >> 1);
          break;
        case 4:
          reconstructed = value + paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`bad PNG filter ${filter}`);
      }
      pixels[dst + x] = reconstructed & 0xff;
    }
  }

  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const src = index * channels;
    const dst = index * 4;
    switch (colorType) {
      case 6:
        data.set(pixels.subarray(src, src + 4), dst);
        break;
      case 2:
        data[dst] = pixels[src];
        data[dst + 1] = pixels[src + 1];
        data[dst + 2] = pixels[src + 2];
        data[dst + 3] = 255;
        break;
      case 4:
        data[dst] = data[dst + 1] = data[dst + 2] = pixels[src];
        data[dst + 3] = pixels[src + 1];
        break;
      case 0:
        data[dst] = data[dst + 1] = data[dst + 2] = pixels[src];
        data[dst + 3] = 255;
        break;
      case 3: {
        const index3 = pixels[src];
        data[dst] = palette?.[index3 * 3] ?? 0;
        data[dst + 1] = palette?.[index3 * 3 + 1] ?? 0;
        data[dst + 2] = palette?.[index3 * 3 + 2] ?? 0;
        data[dst + 3] = transparency?.[index3] ?? 255;
        break;
      }
    }
  }
  return { width, height, data };
}

module.exports = { decodePng, encodePng };
