const assert = require("node:assert/strict");
const test = require("node:test");
const { DEFAULT_SETTINGS, normalizePort, normalizeSettings } = require("../src/plugin/settings.js");

test("settings default to port 8003, pixel scaling, black opaque background", () => {
  const defaults = {
    port: 8003,
    scaleMode: "pixel",
    backgroundColor: "#000000",
    backgroundTransparency: 0,
    removeBlackBackground: false,
  };
  assert.deepEqual(normalizeSettings(), defaults);
  assert.deepEqual(normalizeSettings({}), defaults);
  assert.deepEqual(normalizeSettings(null), defaults);
  assert.equal(DEFAULT_SETTINGS.port, 8003);
  assert.equal(DEFAULT_SETTINGS.backgroundColor, "#000000");
  assert.equal(DEFAULT_SETTINGS.backgroundTransparency, 0);
  assert.equal(DEFAULT_SETTINGS.removeBlackBackground, false);
});

test("a configured background colour and transparency are kept", () => {
  assert.equal(normalizeSettings({ backgroundColor: "#1122Ab" }).backgroundColor, "#1122ab");
  assert.equal(normalizeSettings({ backgroundColor: "#ff8800" }).backgroundColor, "#ff8800");
  assert.equal(normalizeSettings({ backgroundTransparency: 40 }).backgroundTransparency, 40);
  assert.equal(normalizeSettings({ backgroundTransparency: "75" }).backgroundTransparency, 75);
  assert.equal(normalizeSettings({ backgroundTransparency: 100 }).backgroundTransparency, 100);
});

test("invalid background values fall back to black and opaque", () => {
  for (const value of ["red", "#12345", "112233", "", 123456, null, undefined])
    assert.equal(normalizeSettings({ backgroundColor: value }).backgroundColor, "#000000", `colour ${String(value)}`);
  for (const value of [-1, 101, 12.5, "abc", null, undefined, "", NaN, Infinity])
    assert.equal(normalizeSettings({ backgroundTransparency: value }).backgroundTransparency, 0, `transparency ${String(value)}`);
});

test("a configured port is kept, including 0 for an automatic port", () => {
  const defaults = { scaleMode: "pixel", backgroundColor: "#000000", backgroundTransparency: 0, removeBlackBackground: false };
  assert.deepEqual(normalizeSettings({ port: 8123 }), { port: 8123, ...defaults });
  assert.deepEqual(normalizeSettings({ port: "8123" }), { port: 8123, ...defaults });
  assert.deepEqual(normalizeSettings({ port: 0 }), { port: 0, ...defaults });
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

test("the black-removal checkbox is a normalized boolean, off unless truly enabled", () => {
  assert.equal(normalizeSettings({ removeBlackBackground: true }).removeBlackBackground, true);
  assert.equal(normalizeSettings({ removeBlackBackground: "true" }).removeBlackBackground, true);
  for (const value of [false, "false", "yes", 1, 0, "", null, undefined, NaN, {}])
    assert.equal(normalizeSettings({ removeBlackBackground: value }).removeBlackBackground, false, `value ${String(value)}`);
});

test("unknown keys never leak into the normalized settings", () => {
  assert.deepEqual(normalizeSettings({ port: 8100, scaleMode: "fill", removeBlackBackground: true, githubToken: "x" }), {
    port: 8100,
    scaleMode: "fill",
    backgroundColor: "#000000",
    backgroundTransparency: 0,
    removeBlackBackground: true,
  });
});
