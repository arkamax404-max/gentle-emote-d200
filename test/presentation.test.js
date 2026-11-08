const assert = require("node:assert/strict");
const test = require("node:test");
const { frameDataUri, placeholderDataUri, placeholderSvg, targetLabel } = require("../src/plugin/presentation.js");
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

test("a received frame becomes the key image in pixel mode", () => {
  const uri = frameDataUri(frame(), { scaleMode: "pixel" });
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
  const pixel = frameDataUri(frame(), { scaleMode: "pixel" });
  const fill = frameDataUri(frame(), { scaleMode: "fill" });
  assert.notEqual(pixel, fill);
  const png = decodePng(Buffer.from(fill.split(",")[1], "base64"));
  assert.deepEqual([...png.data.subarray(0, 4)], [11, 22, 33, 255]);
});
