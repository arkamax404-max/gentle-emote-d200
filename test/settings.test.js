const assert = require("node:assert/strict");
const test = require("node:test");
const { DEFAULT_SETTINGS, normalizePort, normalizeSettings } = require("../src/plugin/settings.js");

const defaults = { port: 8003, scaleMode: "pixel", backgroundColor: "#000000" };
test("settings default to port 8003, pixel scaling and black", () => {
  for (const value of [undefined, {}, null]) assert.deepEqual(normalizeSettings(value), defaults);
  assert.deepEqual(DEFAULT_SETTINGS, defaults);
});
test("a configured port is kept, including 0 for an automatic port", () => {
  for (const port of [8123, "8123", 0])
    assert.deepEqual(normalizeSettings({ port }), { ...defaults, port: Number(port) });
});
test("impossible ports fall back to the default instead of failing", () => {
  for (const value of [-1, 70000, 12.5, "abc", null, undefined, "", NaN, Infinity])
    assert.equal(normalizePort(value), 8003, `port ${String(value)}`);
});
test("both scaling modes are accepted and anything else falls back to pixel", () => {
  for (const scaleMode of ["pixel", "fill"]) assert.equal(normalizeSettings({ scaleMode }).scaleMode, scaleMode);
  for (const scaleMode of ["bicubic", "", null, 3, undefined])
    assert.equal(normalizeSettings({ scaleMode }).scaleMode, "pixel");
});
test("unknown keys never leak into the normalized settings", () => {
  assert.deepEqual(normalizeSettings({ port: 8100, scaleMode: "fill", githubToken: "x" }), {
    ...defaults, port: 8100, scaleMode: "fill",
  });
});
test("RGB hex backgrounds are strict, normalized and safely defaulted", () => {
  for (const [input, expected] of [["#123abc", "#123abc"], ["#ABCDEF", "#abcdef"], ["#FFFFFF", "#ffffff"], ["#000000", "#000000"]])
    assert.deepEqual(normalizeSettings({ port: 8123, scaleMode: "fill", backgroundColor: input }), {
      port: 8123, scaleMode: "fill", backgroundColor: expected,
    });
  for (const backgroundColor of [undefined, null, 0, [], {}, "", "red", "123456", "#fff", "#12345678", " #123456", "#123456\n", "#gg0000"])
    assert.equal(normalizeSettings({ backgroundColor }).backgroundColor, "#000000", String(backgroundColor));
});
