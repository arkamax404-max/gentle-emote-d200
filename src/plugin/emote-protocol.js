"use strict";

// Parses the gentle-emote external-display "Receiver protocol v1" request, as produced by
// src/external_display.ts in the gentle-emote repo: POST, Content-Type image/png, a raw
// 64x64 PNG body and X-Emote-* metadata headers. Nothing here trusts the sender: every
// header is bounded, unknown values become null, and only the PNG is ever required.
const MAX_BODY_BYTES = 256 * 1024;
const PROTOCOL_VERSION = "1";
const IDENTIFIER = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const STREAM_ID = /^[A-Za-z0-9-]{1,64}$/;
const SEQUENCE = /^\d{1,20}$/;
const STATUSES = Object.freeze(["idle", "busy", "error"]);
const PHASES = Object.freeze(["idle", "thinking", "responding", "executing", "waiting", "compacting"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SUBAGENTS = 999999;

function header(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0].trim() : null;
  return typeof value === "string" ? value.trim() : null;
}

function identifier(value) {
  return value !== null && IDENTIFIER.test(value) ? value : null;
}

function enumeration(value, allowed) {
  return value !== null && allowed.includes(value) ? value : null;
}

function subagentCount(value) {
  if (value === null || !/^\d{1,7}$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= MAX_SUBAGENTS ? parsed : MAX_SUBAGENTS;
}

/** `{ ok: true, frame }` for a valid v1 request, otherwise `{ ok: false, status, reason }`. */
function parseEmoteRequest(request) {
  const method = String(request?.method || "").toUpperCase();
  if (method !== "POST") return { ok: false, status: 405, allow: "POST", reason: "method not allowed" };
  const headers = request.headers || {};
  const contentType = header(headers, "content-type");
  if (!contentType || !/^image\/png\s*(;|$)/i.test(contentType))
    return { ok: false, status: 415, reason: "expected Content-Type image/png" };
  const version = header(headers, "x-emote-version");
  if (version !== PROTOCOL_VERSION)
    return { ok: false, status: 400, reason: `unsupported protocol version (expected ${PROTOCOL_VERSION})` };
  const body = request.body;
  if (!Buffer.isBuffer(body) || body.length === 0) return { ok: false, status: 400, reason: "empty body" };
  if (body.length > MAX_BODY_BYTES) return { ok: false, status: 413, reason: "frame too large" };
  if (body.length < PNG_SIGNATURE.length || !body.subarray(0, 8).equals(PNG_SIGNATURE))
    return { ok: false, status: 415, reason: "body is not a PNG" };
  const sequence = header(headers, "x-emote-sequence");
  return {
    ok: true,
    frame: {
      png: body,
      state: identifier(header(headers, "x-emote-state")),
      frame: identifier(header(headers, "x-emote-frame")),
      set: identifier(header(headers, "x-emote-set")),
      status: enumeration(header(headers, "x-emote-status"), STATUSES),
      phase: enumeration(header(headers, "x-emote-phase"), PHASES),
      activeSubagents: subagentCount(header(headers, "x-emote-active-subagents")),
      streamId: STREAM_ID.test(header(headers, "x-emote-stream-id") || "") ? header(headers, "x-emote-stream-id") : null,
      sequence: SEQUENCE.test(sequence || "") ? Number(sequence) : null,
    },
  };
}

module.exports = {
  IDENTIFIER,
  MAX_BODY_BYTES,
  PHASES,
  PROTOCOL_VERSION,
  STATUSES,
  parseEmoteRequest,
};
