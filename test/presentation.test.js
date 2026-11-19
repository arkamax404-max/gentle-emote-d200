const assert = require("node:assert/strict");
const test = require("node:test");
const { frameDataUri, framePngDataUri, placeholderDataUri, placeholderSvg, targetLabel } = require("../src/plugin/presentation.js");
const { decodePng } = require("../src/plugin/png.js");
const { KEY_SIZE } = require("../src/plugin/scale.js");

function decodedSvg(uri) {
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  return Buffer.from(uri.split(",")[1], "base64").toString("utf8");
}

function frame(color = [11, 22, 33, 255]) {
  const data = new Uint8Array(64 * 64 * 4);
  for (let index = 0; index < 64 * 64; index += 1) data.set(color, index * 4);
  return { image: { width: 64, height: 64, data }, id: 1 };
}

test("the placeholder shows the URL to configure in gentle-emote", () => {
  const svg = decodedSvg(placeholderDataUri({ target: "http://127.0.0.1:8123/emote" }));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="196" height="196"/);
  assert.match(svg, />127\.0\.0\.1:8123</);
  assert.match(svg, /GENTLE EMOTE/);
  assert.match(svg, /WAITING FOR EMOTE/);
});

test("the placeholder never renders an unbindable target", () => {
  assert.equal(targetLabel(null), "NO PORT");
  assert.equal(targetLabel("not a url"), "NO PORT");
  assert.equal(targetLabel("http://localhost:8000/emote"), "localhost:8000");
  assert.match(decodedSvg(placeholderDataUri({})), /NO PORT/);
});

test("placeholder text is escaped and bounded", () => {
  const svg = placeholderSvg({ detail: "<script>alert(1)</script> and more text here" });
  assert.ok(!svg.includes("<script>"));
  assert.match(svg, /&lt;SCRIPT&gt;/);
  const label = svg
    .match(/font-size="13"[^>]*>([^<]*)</)[1]
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
  // The visible detail is bounded before escaping, so the key text never overflows.
  assert.equal(label, "<SCRIPT>ALERT(1)</SCRIPT>".slice(0, 24).toUpperCase());
});

test("a received frame becomes a 196x196 PNG key image in pixel mode", () => {
  const uri = framePngDataUri(frame(), { scaleMode: "pixel" });
  assert.match(uri, /^data:image\/png;base64,/);
  const png = decodePng(Buffer.from(uri.split(",")[1], "base64"));
  assert.equal(png.width, KEY_SIZE);
  assert.equal(png.height, KEY_SIZE);
  const center = (96 * KEY_SIZE + 96) * 4;
  assert.deepEqual([...png.data.subarray(center, center + 4)], [11, 22, 33, 255]);
  const corner = 0;
  assert.deepEqual([...png.data.subarray(corner, corner + 4)], [0, 0, 0, 255]);
});

test("fill mode produces a different key image than pixel mode", () => {
  const pixel = framePngDataUri(frame(), { scaleMode: "pixel" });
  const fill = framePngDataUri(frame(), { scaleMode: "fill" });
  assert.notEqual(pixel, fill);
  const png = decodePng(Buffer.from(fill.split(",")[1], "base64"));
  assert.deepEqual([...png.data.subarray(0, 4)], [11, 22, 33, 255]);
});

/** The key paints SVG, with the scaled PNG embedded 1:1 so nothing is resampled. */
function embeddedKeyPng(uri) {
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="196" height="196"/);
  assert.match(svg, /<image x="0" y="0" width="196" height="196" href="data:image\/png;base64,[A-Za-z0-9+/=]+"\/>/);
  const base64 = /href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(svg)[1];
  return decodePng(Buffer.from(base64, "base64"));
}

test("selected background composites alpha, preserves opaque pixels and source, and produces opaque PNG", () => {
  const source = frame();
  source.image.data.set([99, 88, 77, 0], 0);
  source.image.data.set([200, 100, 50, 128], 4);
  source.image.data.set([0, 0, 0, 255], 8);
  const before = source.image.data.slice();
  const png = embeddedKeyPng(frameDataUri(source, { backgroundColor: "#204060" }));
  const pixel = (x, y) => [...png.data.subarray((y * KEY_SIZE + x) * 4, (y * KEY_SIZE + x) * 4 + 4)];
  assert.deepEqual(pixel(0, 0), [32, 64, 96, 255]);
  assert.deepEqual(pixel(2, 2), [32, 64, 96, 255]);
  assert.deepEqual(pixel(5, 2), [116, 82, 73, 255]);
  assert.deepEqual(pixel(8, 2), [0, 0, 0, 255]);
  assert.deepEqual(pixel(11, 2), [11, 22, 33, 255]);
  for (let i = 3; i < png.data.length; i += 4) assert.equal(png.data[i], 255);
  assert.deepEqual(source.image.data, before);
  const fill = decodePng(Buffer.from(framePngDataUri(frame(), { scaleMode: "fill", backgroundColor: "#204060" }).split(",")[1], "base64"));
  assert.deepEqual([...fill.data.subarray(0, 4)], [11, 22, 33, 255]);
});

test("presentation defaults invalid or missing backgrounds to black", () => {
  for (const settings of [undefined, {}, { backgroundColor: "bad" }]) {
    const png = embeddedKeyPng(frameDataUri(frame([99, 88, 77, 0]), settings));
    assert.deepEqual([...png.data.subarray(0, 4)], [0, 0, 0, 255]);
    assert.deepEqual([...png.data.subarray((96 * KEY_SIZE + 96) * 4, (96 * KEY_SIZE + 96) * 4 + 4)], [0, 0, 0, 255]);
  }
});

test("placeholder uses selected background without changing text or accent", () => {
  const original = placeholderSvg({ target: "http://127.0.0.1:8123/emote" });
  const selected = placeholderSvg({ target: "http://127.0.0.1:8123/emote", backgroundColor: "#ABCDEF" });
  assert.equal(selected, original.replace('fill="#000000"', 'fill="#abcdef"'));
  assert.equal(placeholderSvg({ backgroundColor: "bad" }), placeholderSvg());
});

test("the key payload is an SVG wrapper with the scaled PNG inside", () => {
  const png = embeddedKeyPng(frameDataUri(frame(), { scaleMode: "pixel" }));
  assert.equal(png.width, KEY_SIZE);
  assert.equal(png.height, KEY_SIZE);
  const center = (96 * KEY_SIZE + 96) * 4;
  assert.deepEqual([...png.data.subarray(center, center + 4)], [11, 22, 33, 255]);
  assert.deepEqual([...png.data.subarray(0, 4)], [0, 0, 0, 255]);
});
