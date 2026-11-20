"use strict";

// What the key shows: the newest emote frame, or a placeholder that tells the user which
// local URL to put in gentle-emote's `externalDisplay.url` while nothing has arrived yet.
const { encodePng } = require("./png.js");
const { KEY_SIZE, scaleFrame } = require("./scale.js");

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

function placeholderSvg({ target = null, detail = "WAITING FOR EMOTE", settings = null } = {}) {
  const address = escapeXml(targetLabel(target));
  const line = escapeXml(String(detail).slice(0, 24).toUpperCase());
  // The waiting canvas is background too: the configured colour and transparency
  // apply here as well, so a placed key never stays black against the user's choice.
  const [red, green, blue] = hexToRgb(settings?.backgroundColor);
  const alpha = Math.round(backgroundAlpha(settings) * 100) / 100;
  const opacity = alpha === 1 ? "" : ` fill-opacity="${alpha}"`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${KEY_SIZE}" height="${KEY_SIZE}" viewBox="0 0 ${KEY_SIZE} ${KEY_SIZE}">`,
    `<rect width="${KEY_SIZE}" height="${KEY_SIZE}" fill="rgb(${red},${green},${blue})"${opacity}/>`,
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

/** `#rrggbb` (or a safe black) -> the RGB triple the scaler composites over. */
function hexToRgb(value) {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) return [0, 0, 0];
  return [
    parseInt(value.slice(1, 3), 16),
    parseInt(value.slice(3, 5), 16),
    parseInt(value.slice(5, 7), 16),
  ];
}

/** Background transparency 0-100 -> the alpha the canvas margins and empty areas carry. */
function backgroundAlpha(settings) {
  const value = settings?.backgroundTransparency;
  const transparency = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return 1 - Math.min(100, Math.max(0, transparency)) / 100;
}

function keyPng(frame, settings) {
  return encodePng(scaleFrame(frame.image, {
    mode: settings?.scaleMode,
    background: hexToRgb(settings?.backgroundColor),
    backgroundAlpha: backgroundAlpha(settings),
    removeBlackBackground: settings?.removeBlackBackground,
  }));
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
