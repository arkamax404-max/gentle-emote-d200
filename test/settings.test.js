const assert = require("node:assert/strict");
const test = require("node:test");
const { DEFAULT_SETTINGS, normalizePort, normalizeSettings } = require("../src/plugin/settings.js");

test("settings default to port 8003 and pixel scaling", () => {
  assert.deepEqual(normalizeSettings(), { port: 8003, scaleMode: "pixel" });
  assert.deepEqual(normalizeSettings({}), { port: 8003, scaleMode: "pixel" });
  assert.deepEqual(normalizeSettings(null), { port: 8003, scaleMode: "pixel" });
  assert.equal(DEFAULT_SETTINGS.port, 8003);
});

test("a configured port is kept, including 0 for an automatic port", () => {
  assert.deepEqual(normalizeSettings({ port: 8123 }), { port: 8123, scaleMode: "pixel" });
  assert.deepEqual(normalizeSettings({ port: "8123" }), { port: 8123, scaleMode: "pixel" });
  assert.deepEqual(normalizeSettings({ port: 0 }), { port: 0, scaleMode: "pixel" });
});

test("impossible ports fall back to the default instead of failing", () => {
  for (const value of [-1, 70000, 12.5, "abc", null, undefined, "", NaN, Infinity])
    assert.equal(normalizePort(value), 8003, `port ${String(value)}`);
});

test("both scaling modes are accepted and anything else falls back to pixel", () => {
  assert.equal(normalizeSettings({ scaleMode: "fill" }).scaleMode, "fill");
  assert.equal(normalizeSettings({ scaleMode: "pixel" }).scaleMode, "pixel");
  for (const value of ["bicubic", "", null, 3, undefined])
    assert.equal(normalizeSettings({ scaleMode: value }).scaleMode, "pixel");
});

test("unknown keys never leak into the normalized settings", () => {
  assert.deepEqual(normalizeSettings({ port: 8100, scaleMode: "fill", githubToken: "x" }), {
    port: 8100,
    scaleMode: "fill",
  });
});
