"use strict";

const { DEFAULT_PORT } = require("./emote-server.js");
const { SCALE_MODES } = require("./scale.js");

const DEFAULT_SETTINGS = Object.freeze({
  port: DEFAULT_PORT,
  scaleMode: "pixel",
  backgroundColor: "#000000",
  backgroundTransparency: 0,
  removeBlackBackground: false,
});
const MAX_PORT = 65535;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Port 0 asks the OS for a free port, which is useful when 8003 is already taken. */
function normalizePort(value) {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_PORT) return DEFAULT_SETTINGS.port;
  return parsed;
}

/** Only `#rrggbb` colours are accepted; anything else falls back to black. */
function normalizeBackgroundColor(value) {
  return typeof value === "string" && HEX_COLOR.test(value)
    ? value.toLowerCase()
    : DEFAULT_SETTINGS.backgroundColor;
}

/** 0 keeps the background opaque, 100 makes it fully transparent; anything else falls back to 0. */
function normalizeBackgroundTransparency(value) {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100)
    return DEFAULT_SETTINGS.backgroundTransparency;
  return parsed;
}

/** Checkbox: only a genuine `true` (or the string form a host may echo back) enables removal. */
function normalizeRemoveBlackBackground(value) {
  return value === true || value === "true";
}

function normalizeSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    port: normalizePort(source.port),
    scaleMode: SCALE_MODES.includes(source.scaleMode) ? source.scaleMode : DEFAULT_SETTINGS.scaleMode,
    backgroundColor: normalizeBackgroundColor(source.backgroundColor),
    backgroundTransparency: normalizeBackgroundTransparency(source.backgroundTransparency),
    removeBlackBackground: normalizeRemoveBlackBackground(source.removeBlackBackground),
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  MAX_PORT,
  normalizeBackgroundTransparency,
  normalizeBackgroundColor,
  normalizePort,
  normalizeRemoveBlackBackground,
  normalizeSettings,
};
