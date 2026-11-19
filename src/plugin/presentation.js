"use strict";

// What the key shows: the newest emote frame, or a placeholder that tells the user which
// local URL to put in gentle-emote's `externalDisplay.url` while nothing has arrived yet.
const { encodePng } = require("./png.js");
const { KEY_SIZE, scaleFrame } = require("./scale.js");

const { normalizeBackgroundColor } = require("./settings.js");
const PLACEHOLDER_ACCENT = "#f0c040";
const PLACEHOLDER_TEXT = "#ffffff";
const PLACEHOLDER_MUTED = "#8a8a8a";

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function svgDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

/** Address line for the key: `127.0.0.1:8003` from the receiver target, or a clear gap. */
function targetLabel(target) {
  if (!target) return "NO PORT";
  try {
    const url = new URL(target);
    return `${url.hostname}:${url.port || "80"}`;
  } catch {
    return "NO PORT";
  }
}

function placeholderSvg({ target = null, detail = "WAITING FOR EMOTE", backgroundColor } = {}) {
  const address = escapeXml(targetLabel(target));
  const line = escapeXml(String(detail).slice(0, 24).toUpperCase());
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY_SIZE}" height="${KEY_SIZE}" viewBox="0 0 ${KEY_SIZE} ${KEY_SIZE}">`,
    `<rect width="${KEY_SIZE}" height="${KEY_SIZE}" fill="${normalizeBackgroundColor(backgroundColor)}"/>`,
    `<rect x="12" y="12" width="${KEY_SIZE - 24}" height="${KEY_SIZE - 24}" fill="none" stroke="${PLACEHOLDER_ACCENT}" stroke-width="2" stroke-dasharray="6 6"/>`,
    `<text x="${KEY_SIZE / 2}" y="70" fill="${PLACEHOLDER_ACCENT}" font-family="monospace" font-size="18" font-weight="bold" letter-spacing="2" text-anchor="middle">GENTLE EMOTE</text>`,
    `<text x="${KEY_SIZE / 2}" y="112" fill="${PLACEHOLDER_TEXT}" font-family="monospace" font-size="20" text-anchor="middle">${address}</text>`,
    `<text x="${KEY_SIZE / 2}" y="148" fill="${PLACEHOLDER_MUTED}" font-family="monospace" font-size="13" text-anchor="middle">${line}</text>`,
    "</svg>",
  ].join("");
}

function placeholderDataUri(options) {
  return svgDataUri(placeholderSvg(options));
}

function keyPng(frame, settings) {
  const color = normalizeBackgroundColor(settings?.backgroundColor);
  const background = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  return encodePng(scaleFrame(frame.image, { mode: settings?.scaleMode, background }));
}

/** Key-sized PNG data URI; kept for diagnostics and for callers that want the raw PNG. */
function framePngDataUri(frame, settings) {
  return `data:image/png;base64,${keyPng(frame, settings).toString("base64")}`;
}

/**
 * Decoded frame -> the payload the key paints for a `state` icon (type 1).
 * The D200 renders SVG payloads (as every sibling plugin does); the scaled PNG is embedded
 * 1:1 inside a 196x196 SVG so the device never resamples the pixel art.
 */
function frameDataUri(frame, settings) {
  const png = keyPng(frame, settings).toString("base64");
  return svgDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY_SIZE}" height="${KEY_SIZE}" viewBox="0 0 ${KEY_SIZE} ${KEY_SIZE}">`
      + `<image x="0" y="0" width="${KEY_SIZE}" height="${KEY_SIZE}" href="data:image/png;base64,${png}"/></svg>`,
  );
}

module.exports = { frameDataUri, framePngDataUri, placeholderDataUri, placeholderSvg, svgDataUri, targetLabel };
