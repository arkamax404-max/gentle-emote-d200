"use strict";

const { DEFAULT_PORT } = require("./emote-server.js");
const { SCALE_MODES } = require("./scale.js");

const DEFAULT_SETTINGS = Object.freeze({ port: DEFAULT_PORT, scaleMode: "pixel" });
const MAX_PORT = 65535;

/** Port 0 asks the OS for a free port, which is useful when 8000 is already taken. */
function normalizePort(value) {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_PORT) return DEFAULT_SETTINGS.port;
  return parsed;
}

function normalizeSettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    port: normalizePort(source.port),
    scaleMode: SCALE_MODES.includes(source.scaleMode) ? source.scaleMode : DEFAULT_SETTINGS.scaleMode,
  };
}

module.exports = { DEFAULT_SETTINGS, MAX_PORT, normalizePort, normalizeSettings };
