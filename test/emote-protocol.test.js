const assert = require("node:assert/strict");
const test = require("node:test");
const { MAX_BODY_BYTES, parseEmoteRequest } = require("../src/plugin/emote-protocol.js");
const { encodePng } = require("../src/plugin/png.js");

function framePng(size = 64) {
  const data = new Uint8Array(size * size * 4).fill(255);
  return encodePng({ width: size, height: size, data });
}

const VALID_HEADERS = Object.freeze({
  "content-type": "image/png",
  "x-emote-version": "1",
  "x-emote-state": "think",
  "x-emote-frame": "think.png",
  "x-emote-set": "gentleman",
  "x-emote-status": "busy",
  "x-emote-phase": "thinking",
  "x-emote-active-subagents": "2",
  "x-emote-stream-id": "5a1d7f5e-4f30-4a4d-8b1c-0f1ee1a1a111",
  "x-emote-sequence": "42",
});

test("a protocol v1 request is accepted with its metadata", () => {
  const result = parseEmoteRequest({ method: "POST", headers: VALID_HEADERS, body: framePng() });
  assert.equal(result.ok, true);
  assert.deepEqual(
    { ...result.frame, png: undefined },
    {
      png: undefined,
      state: "think",
      frame: "think.png",
      set: "gentleman",
      status: "busy",
      phase: "thinking",
      activeSubagents: 2,
      streamId: "5a1d7f5e-4f30-4a4d-8b1c-0f1ee1a1a111",
      sequence: 42,
    },
  );
  assert.ok(Buffer.isBuffer(result.frame.png));
});

test("only POST is accepted", () => {
  for (const method of ["GET", "PUT", "DELETE", "HEAD"]) {
    const result = parseEmoteRequest({ method, headers: VALID_HEADERS, body: Buffer.alloc(0) });
    assert.equal(result.ok, false);
    assert.equal(result.status, 405);
    assert.equal(result.allow, "POST");
  }
});

test("only image/png bodies are accepted", () => {
  const wrongType = parseEmoteRequest({
    method: "POST",
    headers: { ...VALID_HEADERS, "content-type": "application/json" },
    body: framePng(),
  });
  assert.equal(wrongType.status, 415);

  const notPng = parseEmoteRequest({ method: "POST", headers: VALID_HEADERS, body: Buffer.from("hello world") });
  assert.equal(notPng.status, 415);
});

test("a request without the v1 version header is rejected", () => {
  for (const version of [undefined, "2", ""]) {
    const headers = { ...VALID_HEADERS };
    if (version === undefined) delete headers["x-emote-version"];
    else headers["x-emote-version"] = version;
    const result = parseEmoteRequest({ method: "POST", headers, body: framePng() });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.match(result.reason, /version/);
  }
});

test("an empty body is rejected", () => {
  const result = parseEmoteRequest({ method: "POST", headers: VALID_HEADERS, body: Buffer.alloc(0) });
  assert.equal(result.status, 400);
  assert.match(result.reason, /body/);
});

test("a body above the limit is rejected without buffering it", () => {
  const result = parseEmoteRequest({ method: "POST", headers: VALID_HEADERS, body: Buffer.alloc(MAX_BODY_BYTES + 1) });
  assert.equal(result.status, 413);
});

test("unknown or malformed metadata never rejects a valid frame", () => {
  const result = parseEmoteRequest({
    method: "POST",
    headers: { ...VALID_HEADERS, "x-emote-state": "bad state!", "x-emote-active-subagents": "-3" },
    body: framePng(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.frame.state, null);
  assert.equal(result.frame.activeSubagents, 0);
});

test("a missing metadata header is reported as absent, not fabricated", () => {
  const headers = { ...VALID_HEADERS };
  for (const name of ["x-emote-state", "x-emote-frame", "x-emote-set", "x-emote-status", "x-emote-phase", "x-emote-stream-id", "x-emote-sequence"])
    delete headers[name];
  const result = parseEmoteRequest({ method: "POST", headers, body: framePng() });
  assert.equal(result.ok, true);
  assert.equal(result.frame.state, null);
  assert.equal(result.frame.frame, null);
  assert.equal(result.frame.set, null);
  assert.equal(result.frame.status, null);
  assert.equal(result.frame.phase, null);
  assert.equal(result.frame.streamId, null);
  assert.equal(result.frame.sequence, null);
});

test("header values are bounded and content-type parameters are tolerated", () => {
  const long = "a".repeat(500);
  const result = parseEmoteRequest({
    method: "POST",
    headers: {
      ...VALID_HEADERS,
      "content-type": "image/png; charset=binary",
      "x-emote-state": long,
      "x-emote-status": long,
      "x-emote-phase": long,
      "x-emote-stream-id": long,
      "x-emote-sequence": "99999999999999999999999",
    },
    body: framePng(),
  });
  assert.equal(result.ok, true);
  assert.equal(result.frame.state, null);
  assert.equal(result.frame.status, null);
  assert.equal(result.frame.phase, null);
  assert.equal(result.frame.streamId, null);
  assert.equal(result.frame.sequence, null);
});
