"use strict";

const { DEFAULT_PORT } = require("./emote-server.js");
const { SCALE_MODES } = require("./scale.js");

const DEFAULT_SETTINGS = Object.freeze({ port: DEFAULT_PORT, scaleMode: "pixel", backgroundColor: "#000000" });
const MAX_PORT = 65535;

/** Port 0 asks the OS for a free port, which is useful when 8003 is already taken. */
function normalizePort(value) {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_PORT) return DEFAULT_SETTINGS.port;
  return parsed;
}

/** Only six-digit RGB hex is accepted; never allow arbitrary SVG/CSS input. */
function normalizeBackgroundColor(value) {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) && value.length === 7
    ? value.toLowerCase()
    : DEFAULT_SETTINGS.backgroundColor;
}

function normalizeSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    port: normalizePort(source.port),
    backgroundColor: normalizeBackgroundColor(source.backgroundColor),
    scaleMode: SCALE_MODES.includes(source.scaleMode) ? source.scaleMode : DEFAULT_SETTINGS.scaleMode,
  };
}

module.exports = { DEFAULT_SETTINGS, MAX_PORT, normalizeBackgroundColor, normalizePort, normalizeSettings };
