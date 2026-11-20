const assert = require("node:assert/strict");
const test = require("node:test");
const { MAX_BODY_BYTES, parseEmoteRequest, parseLifecycleRequest } = require("../src/plugin/emote-protocol.js");
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
      sessionId: null,
      sequence: 42,
      sequenceRaw: "42",
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
  assert.equal(result.frame.sessionId, null);
  assert.equal(result.frame.sequence, null);
  assert.equal(result.frame.sequenceRaw, null);
});

// --- additive focus identity (task T2/S1); legacy display behaviour above is unchanged ---

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
  assert.equal(result.frame.sequenceRaw, null);
});

// --- additive focus identity (task T2/S1); legacy display behaviour above is unchanged ---

test("focus session identity is validated and bounded", () => {
  const valid = parseEmoteRequest({
    method: "POST",
    headers: { ...VALID_HEADERS, "x-emote-session-id": "sess-1:alpha_beta-dots.and" },
    body: framePng(),
  });
  assert.equal(valid.frame.sessionId, "sess-1:alpha_beta-dots.and");
  const max = parseEmoteRequest({
    method: "POST",
    headers: { ...VALID_HEADERS, "x-emote-session-id": "a".repeat(128) },
    body: framePng(),
  });
  assert.equal(max.frame.sessionId, "a".repeat(128));
  for (const bad of ["a".repeat(129), "has space", "semi;colon"])
    assert.equal(
      parseEmoteRequest({ method: "POST", headers: { ...VALID_HEADERS, "x-emote-session-id": bad }, body: framePng() }).frame.sessionId,
      null,
      bad,
    );
});

test("the raw u64 sequence is captured without changing the legacy numeric field", () => {
  const max = parseEmoteRequest({
    method: "POST",
    headers: { ...VALID_HEADERS, "x-emote-sequence": "18446744073709551615" },
    body: framePng(),
  });
  assert.equal(max.frame.sequenceRaw, "18446744073709551615");
  assert.equal(max.frame.sequence, 18446744073709551615);
  const zeros = parseEmoteRequest({
    method: "POST",
    headers: { ...VALID_HEADERS, "x-emote-sequence": "0007" },
    body: framePng(),
  });
  assert.equal(zeros.frame.sequenceRaw, "0007");
  assert.equal(BigInt(zeros.frame.sequenceRaw), 7n);
  // u64 overflow is not a valid focus sequence but stays a legacy display frame.
  const overflow = parseEmoteRequest({
    method: "POST",
    headers: { ...VALID_HEADERS, "x-emote-sequence": "18446744073709551616" },
    body: framePng(),
  });
  assert.equal(overflow.frame.sequenceRaw, null);
  assert.equal(overflow.ok, true);
});

test("duplicate identity headers are flagged through rawHeaders", () => {
  const rawHeaders = [
    "Content-Type", "image/png",
    "X-Emote-Version", "1",
    "X-Emote-Session-Id", "sess-a",
    "X-Emote-Session-Id", "sess-a",
    "X-Emote-Stream-Id", "stream-a",
    "X-Emote-Sequence", "5",
  ];
  const duplicated = parseEmoteRequest({ method: "POST", headers: VALID_HEADERS, rawHeaders, body: framePng() });
  assert.equal(duplicated.duplicateIdentity, true);
  // Fixture correction: slice(0, 8) still contained the duplicated session pair (the
  // writer counted header pairs as elements). A clean list is the first two pairs.
  const clean = parseEmoteRequest({ method: "POST", headers: VALID_HEADERS, rawHeaders: rawHeaders.slice(0, 4), body: framePng() });
  assert.equal(clean.duplicateIdentity, false);
  const noRaw = parseEmoteRequest({ method: "POST", headers: VALID_HEADERS, body: framePng() });
  assert.equal(noRaw.duplicateIdentity, false);
});

test("origin-bearing requests are flagged", () => {
  const withOrigin = parseEmoteRequest({
    method: "POST",
    headers: { ...VALID_HEADERS, origin: "http://evil.example" },
    body: framePng(),
  });
  assert.equal(withOrigin.originPresent, true);
  assert.equal(parseEmoteRequest({ method: "POST", headers: VALID_HEADERS, body: framePng() }).originPresent, false);
});

test("a lifecycle request parses to an exact identity", () => {
  const result = parseLifecycleRequest({
    method: "POST",
    headers: {
      "x-emote-version": "1",
      "x-emote-session-id": "sess-a",
      "x-emote-stream-id": "stream-a",
      "x-emote-sequence": "0007",
      "content-type": "text/plain",
    },
    body: Buffer.alloc(0),
  });
  assert.equal(result.ok, true);
  assert.equal(result.identity.session, "sess-a");
  assert.equal(result.identity.stream, "stream-a");
  assert.equal(result.identity.sequence, 7n);
});

test("a lifecycle request with an origin is rejected with 403", () => {
  const result = parseLifecycleRequest({
    method: "POST",
    headers: {
      "x-emote-version": "1",
      "x-emote-session-id": "sess-a",
      "x-emote-stream-id": "stream-a",
      "x-emote-sequence": "1",
      origin: "http://evil.example",
    },
    body: Buffer.alloc(0),
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
});

test("malformed lifecycle requests are rejected without identity", () => {
  const identity = {
    "x-emote-version": "1",
    "x-emote-session-id": "sess-a",
    "x-emote-stream-id": "stream-a",
    "x-emote-sequence": "1",
  };
  const cases = [
    [{ method: "GET", headers: identity, body: Buffer.alloc(0) }, 405],
    [{ method: "POST", headers: identity, body: Buffer.from("x") }, 400],
    [{ method: "POST", headers: { ...identity, "x-emote-version": "2" }, body: Buffer.alloc(0) }, 400],
    [{ method: "POST", headers: { ...identity, "x-emote-session-id": undefined }, body: Buffer.alloc(0) }, 400],
    [{ method: "POST", headers: { ...identity, "x-emote-stream-id": undefined }, body: Buffer.alloc(0) }, 400],
    [{ method: "POST", headers: { ...identity, "x-emote-sequence": "18446744073709551616" }, body: Buffer.alloc(0) }, 400],
    [{ method: "POST", headers: { ...identity, "x-emote-sequence": "nope" }, body: Buffer.alloc(0) }, 400],
    [{
      method: "POST",
      headers: identity,
      rawHeaders: ["X-Emote-Version", "1", "X-Emote-Version", "1", "X-Emote-Session-Id", "s", "X-Emote-Stream-Id", "t", "X-Emote-Sequence", "1"],
      body: Buffer.alloc(0),
    }, 400],
  ];
  for (const [request, expected] of cases) {
    const result = parseLifecycleRequest(request);
    assert.equal(result.ok, false);
    assert.equal(result.status, expected, JSON.stringify(request.headers));
  }
});
