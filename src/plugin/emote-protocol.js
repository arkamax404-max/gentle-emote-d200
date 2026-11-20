"use strict";

// Parses the gentle-emote external-display "Receiver protocol v1" request, as produced by
// src/external_display.ts in the gentle-emote repo: POST, Content-Type image/png, a raw
// 64x64 PNG body and X-Emote-* metadata headers. Nothing here trusts the sender: every
// header is bounded, unknown values become null, and only the PNG is ever required.
const MAX_BODY_BYTES = 256 * 1024;
const PROTOCOL_VERSION = "1";
const IDENTIFIER = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const SESSION_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const STREAM_ID = /^[A-Za-z0-9-]{1,64}$/;
// Focus gates use the raw ASCII decimal: u64 range 0..18446744073709551615, leading
// zeros preserved. The legacy numeric field stays separate.
const U64_MAX = 18446744073709551615n;
const SEQUENCE = /^\d{1,20}$/;
// Identity headers that must appear at most once to grant focus permissions.
const IDENTITY_HEADERS = Object.freeze([
  "x-emote-version",
  "x-emote-session-id",
  "x-emote-stream-id",
  "x-emote-sequence",
]);
const FOCUS_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
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

/** The exact ASCII decimal of a u64 sequence, leading zeros included, or null. */
function u64Sequence(value) {
  return value !== null && SEQUENCE.test(value) && BigInt(value) <= U64_MAX ? value : null;
}

function hasDuplicateIdentity(rawHeaders) {
  if (!Array.isArray(rawHeaders)) return false;
  const seen = new Map();
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = String(rawHeaders[index]).toLowerCase();
    if (IDENTITY_HEADERS.includes(name)) seen.set(name, (seen.get(name) || 0) + 1);
  }
  for (const count of seen.values()) if (count > 1) return true;
  return false;
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
  const sequenceRawHeader = header(headers, "x-emote-sequence");
  const sequenceRaw = u64Sequence(sequenceRawHeader);
  return {
    ok: true,
    duplicateIdentity: hasDuplicateIdentity(request.rawHeaders),
    originPresent: header(headers, "origin") !== null,
    frame: {
      png: body,
      state: identifier(header(headers, "x-emote-state")),
      frame: identifier(header(headers, "x-emote-frame")),
      set: identifier(header(headers, "x-emote-set")),
      status: enumeration(header(headers, "x-emote-status"), STATUSES),
      phase: enumeration(header(headers, "x-emote-phase"), PHASES),
      activeSubagents: subagentCount(header(headers, "x-emote-active-subagents")),
      streamId: STREAM_ID.test(header(headers, "x-emote-stream-id") || "") ? header(headers, "x-emote-stream-id") : null,
      sessionId: SESSION_ID.test(header(headers, "x-emote-session-id") || "") ? header(headers, "x-emote-session-id") : null,
      sequence: sequenceRaw !== null ? Number(sequenceRaw) : null,
      sequenceRaw,
    },
  };
}

/**
 * Parses the lifecycle packets POST /emote/heartbeat and /emote/close: exact paths (the
 * caller checks), empty bodies, Content-Type ignored, and a complete unique identity
 * version/session/stream/sequence. Origin-bearing or duplicated traffic is rejected so it
 * can never create or change focus state.
 */
function parseLifecycleRequest(request) {
  const method = String(request?.method || "").toUpperCase();
  if (method !== "POST") return { ok: false, status: 405, allow: "POST", reason: "method not allowed" };
  const headers = request.headers || {};
  if (header(headers, "origin") !== null) return { ok: false, status: 403, reason: "origin-bearing requests cannot invoke focus lifecycle" };
  if (Buffer.isBuffer(request.body)) {
    if (request.body.length !== 0) return { ok: false, status: 400, reason: "lifecycle packets have an empty body" };
  } else if (request.body !== undefined && request.body !== null) {
    return { ok: false, status: 400, reason: "lifecycle packets have an empty body" };
  }
  const version = header(headers, "x-emote-version");
  if (version !== PROTOCOL_VERSION)
    return { ok: false, status: 400, reason: `unsupported protocol version (expected ${PROTOCOL_VERSION})` };
  if (hasDuplicateIdentity(request.rawHeaders)) return { ok: false, status: 400, reason: "duplicate identity headers" };
  const session = header(headers, "x-emote-session-id");
  if (!SESSION_ID.test(session || "")) return { ok: false, status: 400, reason: "missing or invalid session identity" };
  const stream = header(headers, "x-emote-stream-id");
  if (!STREAM_ID.test(stream || "")) return { ok: false, status: 400, reason: "missing or invalid stream identity" };
  const sequenceRaw = u64Sequence(header(headers, "x-emote-sequence"));
  if (sequenceRaw === null) return { ok: false, status: 400, reason: "missing or invalid sequence" };
  return { ok: true, identity: { session, stream, sequence: BigInt(sequenceRaw) } };
}

module.exports = {
  FOCUS_REQUEST_ID,
  IDENTIFIER,
  IDENTITY_HEADERS,
  MAX_BODY_BYTES,
  PHASES,
  PROTOCOL_VERSION,
  SEQUENCE,
  SESSION_ID,
  STATUSES,
  U64_MAX,
  parseEmoteRequest,
  parseLifecycleRequest,
};
