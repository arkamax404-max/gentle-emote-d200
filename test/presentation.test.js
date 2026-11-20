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

test("the placeholder paints the configured background colour and transparency", () => {
  const svg = placeholderSvg({ settings: { backgroundColor: "#ffaa00", backgroundTransparency: 37 } });
  assert.match(svg, /fill="rgb\(255,170,0\)" fill-opacity="0\.63"/);
  const transparent = placeholderSvg({ settings: { backgroundColor: "#112233", backgroundTransparency: 100 } });
  assert.match(transparent, /fill="rgb\(17,34,51\)" fill-opacity="0"/);
});

test("the placeholder keeps the opaque black canvas without background settings", () => {
  const svg = placeholderSvg({});
  assert.match(svg, /fill="rgb\(0,0,0\)"\/>/);
  assert.ok(!svg.includes("fill-opacity"));
  // A malformed colour falls back to the same opaque black canvas; an out-of-range
  // transparency clamps to the same 0..100 window the frame-path scaler applies.
  const tampered = placeholderSvg({ settings: { backgroundColor: "red", backgroundTransparency: 150 } });
  assert.match(tampered, /fill="rgb\(0,0,0\)" fill-opacity="0"/);
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

test("the black-removal setting flows through the presentation layer", () => {
  const black = frame([0, 0, 0, 255]);
  const legacy = decodePng(Buffer.from(framePngDataUri(black, { scaleMode: "fill", backgroundColor: "#0a141e" }).split(",")[1], "base64"));
  assert.deepEqual([...legacy.data.subarray(0, 4)], [0, 0, 0, 255]);
  const removed = decodePng(Buffer.from(framePngDataUri(black, { scaleMode: "fill", backgroundColor: "#0a141e", removeBlackBackground: true }).split(",")[1], "base64"));
  assert.deepEqual([...removed.data.subarray(0, 4)], [10, 20, 30, 255]);
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

test("the key payload is an SVG wrapper with the scaled PNG inside", () => {
  const png = embeddedKeyPng(frameDataUri(frame(), { scaleMode: "pixel" }));
  assert.equal(png.width, KEY_SIZE);
  assert.equal(png.height, KEY_SIZE);
  const center = (96 * KEY_SIZE + 96) * 4;
  assert.deepEqual([...png.data.subarray(center, center + 4)], [11, 22, 33, 255]);
  assert.deepEqual([...png.data.subarray(0, 4)], [0, 0, 0, 255]);
});
