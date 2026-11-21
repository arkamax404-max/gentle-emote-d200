const assert = require("node:assert/strict");
const test = require("node:test");
const net = require("node:net");
const { EmoteServer } = require("../src/plugin/emote-server.js");
const { MAX_BODY_BYTES } = require("../src/plugin/emote-protocol.js");
const { encodePng } = require("../src/plugin/png.js");

function framePng(size = 64, color = [9, 9, 9, 255]) {
  const data = new Uint8Array(size * size * 4);
  for (let index = 0; index < size * size; index += 1) data.set(color, index * 4);
  return encodePng({ width: size, height: size, data });
}

function headers(overrides = {}) {
  return {
    "content-type": "image/png",
    "x-emote-version": "1",
    "x-emote-state": "think",
    "x-emote-frame": "think.png",
    "x-emote-set": "gentleman",
    "x-emote-status": "busy",
    "x-emote-phase": "thinking",
    "x-emote-active-subagents": "1",
    "x-emote-stream-id": "stream-a",
    "x-emote-sequence": "7",
    ...overrides,
  };
}

async function withServer(run, options = {}) {
  const server = new EmoteServer({ port: 0, ...options });
  await server.start();
  try {
    await run(server, `http://127.0.0.1:${server.port}/emote`);
  } finally {
    await server.stop();
  }
}

// --- focus handshake helpers (task T2/S1) ---

function focusHeaders({ session = "sess-a", stream = "stream-a", sequence = 1, origin } = {}) {
  return {
    "content-type": "image/png",
    "x-emote-version": "1",
    "x-emote-session-id": session,
    "x-emote-stream-id": stream,
    "x-emote-sequence": String(sequence),
    ...(origin ? { origin } : {}),
  };
}

function lifecycleHeaders({ session = "sess-a", stream = "stream-a", sequence = 2, origin } = {}) {
  return {
    "x-emote-version": "1",
    "x-emote-session-id": session,
    "x-emote-stream-id": stream,
    "x-emote-sequence": String(sequence),
    ...(origin ? { origin } : {}),
  };
}

function fakeClock() {
  const state = { nowMs: 1_000_000 };
  return {
    now: () => state.nowMs,
    advance: (ms) => {
      state.nowMs += ms;
    },
  };
}

/** Sends bytes verbatim so duplicated headers reach the receiver the way Node reports them. */
function rawRequest(port, body, headerLines, path = "/emote") {
  const head =
    [`POST ${path} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close", `Content-Length: ${body.length}`, ...headerLines].join("\r\n") +
    "\r\n\r\n";
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(Buffer.concat([Buffer.from(head), body])));
    const chunks = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString()));
    socket.on("error", reject);
  });
}

test("a valid frame is stored and announced", async () => {
  await withServer(async (server, url) => {
    const frames = [];
    server.on("frame", (frame) => frames.push(frame));
    const response = await fetch(url, { method: "POST", headers: headers(), body: framePng() });
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
    assert.equal(frames.length, 1);
    const last = server.lastFrame;
    assert.equal(last.state, "think");
    assert.equal(last.frame, "think.png");
    assert.equal(last.set, "gentleman");
    assert.equal(last.status, "busy");
    assert.equal(last.phase, "thinking");
    assert.equal(last.activeSubagents, 1);
    assert.equal(last.sequence, 7);
    assert.equal(last.image.width, 64);
    assert.equal(last.image.height, 64);
    assert.deepEqual([...last.image.data.subarray(0, 4)], [9, 9, 9, 255]);
  });
});

test("the newest frame replaces the previous one", async () => {
  await withServer(async (server, url) => {
    await fetch(url, { method: "POST", headers: headers({ "x-emote-sequence": "1" }), body: framePng(64, [1, 1, 1, 255]) });
    await fetch(url, { method: "POST", headers: headers({ "x-emote-sequence": "2" }), body: framePng(64, [2, 2, 2, 255]) });
    assert.equal(server.lastFrame.sequence, 2);
    assert.deepEqual([...server.lastFrame.image.data.subarray(0, 4)], [2, 2, 2, 255]);
  });
});

test("only POST is allowed", async () => {
  await withServer(async (server, url) => {
    const response = await fetch(url);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
    assert.equal(server.lastFrame, null);
  });
});

test("rejections answer with a status and a reason without storing a frame", async () => {
  await withServer(async (server, url) => {
    const cases = [
      [{ "content-type": "text/plain" }, framePng(), 415],
      [headers({ "x-emote-version": "2" }), framePng(), 400],
      [headers({ "x-emote-version": "" }), framePng(), 400],
      [{ ...headers(), "x-emote-version": undefined }, framePng(), 400],
      [headers(), Buffer.from("not a png at all"), 415],
      [headers(), Buffer.alloc(0), 400],
    ];
    for (const [requestHeaders, body, expected] of cases) {
      const response = await fetch(url, { method: "POST", headers: requestHeaders, body });
      assert.equal(response.status, expected, `${JSON.stringify(requestHeaders)} -> ${expected}`);
      const payload = await response.json();
      assert.equal(typeof payload.error, "string");
      assert.ok(payload.error.length > 0);
    }
    assert.equal(server.lastFrame, null);
  });
});

test("a body above the limit is rejected and the server keeps working", async () => {
  await withServer(async (server, url) => {
    const oversized = Buffer.concat([framePng(), Buffer.alloc(MAX_BODY_BYTES)]);
    const rejected = await fetch(url, { method: "POST", headers: headers(), body: oversized });
    assert.equal(rejected.status, 413);
    assert.equal(server.lastFrame, null);
    const accepted = await fetch(url, { method: "POST", headers: headers(), body: framePng() });
    assert.equal(accepted.status, 204);
    assert.ok(server.lastFrame);
  });
});

test("a PNG-signature body that cannot be decoded is rejected", async () => {
  await withServer(async (server, url) => {
    const corrupt = Buffer.concat([framePng().subarray(0, 8), Buffer.alloc(32, 7)]);
    const response = await fetch(url, { method: "POST", headers: headers(), body: corrupt });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /decode|PNG/i);
    assert.equal(server.lastFrame, null);
  });
});

test("any path is accepted so the sender only needs a host and port", async () => {
  await withServer(async (server, url) => {
    const target = new URL(url);
    target.pathname = "/";
    const response = await fetch(target, { method: "POST", headers: headers(), body: framePng() });
    assert.equal(response.status, 204);
    assert.ok(server.lastFrame);
  });
});

test("stop() releases the port", async () => {
  const server = new EmoteServer({ port: 0 });
  await server.start();
  const { port } = server;
  await server.stop();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/emote`, { method: "POST", headers: headers(), body: framePng() }));
  assert.equal(server.port, 0);
});

test("a busy configured port is never replaced: the receiver stays down and reports it", async () => {
  const first = new EmoteServer({ port: 0 });
  await first.start();
  const second = new EmoteServer({ port: first.port });
  const diagnostics = [];
  second.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
  const bound = await second.start();
  try {
    assert.equal(second.listening, false);
    assert.equal(bound.port, 0);
    assert.equal(bound.target, null);
    assert.equal(bound.fallback, false);
    assert.equal(second.port, 0);
    assert.equal(second.blockedPort, first.port);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, "port-in-use");
    assert.equal(diagnostics[0].requestedPort, first.port);
    // The occupier is untouched and keeps serving on the configured port.
    const response = await fetch(`http://127.0.0.1:${first.port}/emote`, {
      method: "POST",
      headers: headers(),
      body: framePng(),
    });
    assert.equal(response.status, 204);
    assert.ok(first.lastFrame);
  } finally {
    await second.stop();
    await first.stop();
  }
});

test("an automatic port is not reported as a fallback", async () => {
  const server = new EmoteServer({ port: 0 });
  const diagnostics = [];
  server.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
  const bound = await server.start();
  try {
    assert.ok(bound.port > 0);
    assert.equal(bound.fallback, false);
    assert.deepEqual(diagnostics, []);
    assert.equal(bound.target, `http://127.0.0.1:${bound.port}/emote`);
  } finally {
    await server.stop();
  }
});

test("the requested port is used when it is free", async () => {
  const probe = new EmoteServer({ port: 0 });
  await probe.start();
  const freePort = probe.port;
  await probe.stop();
  const server = new EmoteServer({ port: freePort });
  const bound = await server.start();
  try {
    assert.equal(bound.port, freePort);
    assert.equal(bound.fallback, false);
    assert.equal(bound.target, `http://127.0.0.1:${freePort}/emote`);
  } finally {
    await server.stop();
  }
});


test("a focus-capable frame is accepted without a focus header until a press queues one", async () => {
  await withServer(async (server, url) => {
    const first = await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 1 }), body: framePng() });
    assert.equal(first.status, 204);
    assert.equal(await first.text(), "");
    assert.equal(first.headers.get("x-emote-focus-request-id"), null);
    assert.ok(server.lastFrame);
    assert.equal(server.lastFrame.focusCapable, true);
    const id = server.sessions.press("sess-a", "stream-a");
    const second = await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 2 }), body: framePng() });
    assert.equal(second.status, 204);
    assert.equal(await second.text(), "");
    assert.equal(second.headers.get("x-emote-focus-request-id"), id);
  });
});

test("a replay frame is answered with an empty 204 and mutates nothing", async () => {
  await withServer(async (server, url) => {
    await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 5 }), body: framePng() });
    const replayed = await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 4 }), body: framePng(64, [1, 1, 1, 255]) });
    assert.equal(replayed.status, 204);
    assert.equal(await replayed.text(), "");
    assert.equal(replayed.headers.get("x-emote-focus-request-id"), null);
    // The stale frame did not replace the displayed frame or the transport state.
    assert.equal(server.lastFrame.sequence, 5);
    const id = server.sessions.press("sess-a", "stream-a");
    const fresh = await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 6 }), body: framePng() });
    assert.equal(fresh.headers.get("x-emote-focus-request-id"), id);
  });
});

test("the focus request id is redelivered within the TTL and expires without extending it", async () => {
  const clock = fakeClock();
  await withServer(async (server, url) => {
    await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 1 }), body: framePng() });
    const id = server.sessions.press("sess-a", "stream-a");
    clock.advance(14_999);
    const within = await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 2 }), body: framePng() });
    assert.equal(within.headers.get("x-emote-focus-request-id"), id);
    clock.advance(1);
    const after = await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 3 }), body: framePng() });
    assert.equal(after.headers.get("x-emote-focus-request-id"), null);
  }, { now: clock.now });
});

test("a matching ack consumes the focus request; wrong or malformed acks are ignored", async () => {
  await withServer(async (server, url) => {
    await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 1 }), body: framePng() });
    const id = server.sessions.press("sess-a", "stream-a");
    const wrong = await fetch(url, { method: "POST", headers: { ...focusHeaders({ sequence: 2 }), "x-emote-focus-ack": "bogus" }, body: framePng() });
    assert.equal(wrong.status, 204);
    const redelivered = await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 3 }), body: framePng() });
    assert.equal(redelivered.headers.get("x-emote-focus-request-id"), id);
    const matched = await fetch(url, { method: "POST", headers: { ...focusHeaders({ sequence: 4 }), "x-emote-focus-ack": id }, body: framePng() });
    assert.equal(matched.status, 204);
    const cleared = await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 5 }), body: framePng() });
    assert.equal(cleared.headers.get("x-emote-focus-request-id"), null);
  });
});

test("heartbeat refreshes the lease without replacing the frame, and delivers focus", async () => {
  await withServer(async (server, url) => {
    await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 1 }), body: framePng(64, [3, 3, 3, 255]) });
    const painted = server.lastFrame;
    const id = server.sessions.press("sess-a", "stream-a");
    const beat = await fetch(`${url}/heartbeat`, {
      method: "POST",
      headers: lifecycleHeaders({ sequence: 2 }),
      body: Buffer.alloc(0),
    });
    assert.equal(beat.status, 204);
    assert.equal(await beat.text(), "");
    assert.equal(beat.headers.get("x-emote-focus-request-id"), id);
    // The heartbeat must not switch the displayed frame or its identity.
    assert.equal(server.lastFrame, painted);
    const ack = await fetch(`${url}/heartbeat`, {
      method: "POST",
      headers: { ...lifecycleHeaders({ sequence: 3 }), "x-emote-focus-ack": id },
      body: Buffer.alloc(0),
    });
    assert.equal(ack.status, 204);
    const cleared = await fetch(`${url}/heartbeat`, { method: "POST", headers: lifecycleHeaders({ sequence: 4 }), body: Buffer.alloc(0) });
    assert.equal(cleared.headers.get("x-emote-focus-request-id"), null);
  });
});

test("heartbeat on unknown, retired, closed or replayed targets is an empty 204 without mutation", async () => {
  await withServer(async (server, url) => {
    const beat = (target, sequence) =>
      fetch(`${url}/heartbeat`, { method: "POST", headers: lifecycleHeaders({ session: target.session, stream: target.stream, sequence }), body: Buffer.alloc(0) });
    assert.equal((await beat({ session: "ghost", stream: "t1" }, 2)).status, 204);
    await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 1 }), body: framePng() });
    await fetch(url, { method: "POST", headers: focusHeaders({ stream: "stream-b", sequence: 1 }), body: framePng() }); // take over
    assert.equal((await beat({ session: "sess-a", stream: "stream-a" }, 5)).status, 204); // retired
    assert.equal((await beat({ session: "sess-a", stream: "stream-b" }, 1)).status, 204); // replay
    assert.equal(server.sessions.press("sess-a", "stream-a"), null);
    assert.equal(server.sessions.press("ghost", "t1"), null);
  });
});

test("close clears focus and a closed stream cannot be revived", async () => {
  await withServer(async (server, url) => {
    await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 1 }), body: framePng() });
    const id = server.sessions.press("sess-a", "stream-a");
    const closed = await fetch(`${url}/close`, { method: "POST", headers: lifecycleHeaders({ sequence: 2 }), body: Buffer.alloc(0) });
    assert.equal(closed.status, 204);
    assert.equal(await closed.text(), "");
    // Close cleared the pending request: the closed stream cannot deliver it anymore.
    const revive = await fetch(`${url}/heartbeat`, { method: "POST", headers: lifecycleHeaders({ sequence: 3 }), body: Buffer.alloc(0) });
    assert.equal(revive.status, 204);
    assert.equal(revive.headers.get("x-emote-focus-request-id"), null);
    assert.equal(server.sessions.press("sess-a", "stream-a"), null);
    // A brand new stream may still take over the session.
    const takeover = await fetch(url, { method: "POST", headers: focusHeaders({ stream: "stream-c", sequence: 1 }), body: framePng() });
    assert.equal(takeover.status, 204);
    assert.ok(server.sessions.press("sess-a", "stream-c"));
  });
});

test("lifecycle packets require exact paths, an empty body and unique identity", async () => {
  await withServer(async (server, url) => {
    const base = `http://127.0.0.1:${new URL(url).port}`;
    const withBody = await fetch(`${base}/emote/heartbeat`, { method: "POST", headers: lifecycleHeaders(), body: "not empty" });
    assert.equal(withBody.status, 400);
    const wrongMethod = await fetch(`${base}/emote/heartbeat`);
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get("allow"), "POST");
    // A query string is not the lifecycle route: it falls through to the frame route.
    const query = await fetch(`${base}/emote/heartbeat?x=1`, { method: "POST", headers: lifecycleHeaders(), body: Buffer.alloc(0) });
    assert.equal(query.status, 415);
    const missingIdentity = await fetch(`${base}/emote/heartbeat`, { method: "POST", body: Buffer.alloc(0) });
    assert.equal(missingIdentity.status, 400);
    // Content-Type is ignored for lifecycle packets; a valid heartbeat still works.
    const ok = await fetch(`${base}/emote/heartbeat`, { method: "POST", headers: { ...lifecycleHeaders(), "content-type": "text/plain" }, body: Buffer.alloc(0) });
    assert.equal(ok.status, 204);
  });
});

test("origin-bearing traffic cannot invoke focus lifecycle or create focus state", async () => {
  await withServer(async (server, url) => {
    const base = `http://127.0.0.1:${new URL(url).port}`;
    const beat = await fetch(`${base}/emote/heartbeat`, { method: "POST", headers: lifecycleHeaders({ origin: "http://evil.example" }), body: Buffer.alloc(0) });
    assert.equal(beat.status, 403);
    const close = await fetch(`${base}/emote/close`, { method: "POST", headers: lifecycleHeaders({ origin: "http://evil.example" }), body: Buffer.alloc(0) });
    assert.equal(close.status, 403);
    // A focus-capable PNG from an origin is downgraded to display-only.
    const downgraded = await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 1, origin: "http://evil.example" }), body: framePng() });
    assert.equal(downgraded.status, 204);
    assert.equal(server.lastFrame.focusCapable, false);
    assert.equal(server.sessions.press("sess-a", "stream-a"), null);
  });
});

test("duplicated identity headers never grant focus", async () => {
  await withServer(async (server, url) => {
    const port = new URL(url).port;
    const png = framePng();
    // Node joins a repeated version header, so the request is rejected outright.
    const dupVersion = await rawRequest(port, png, [
      "Content-Type: image/png",
      "X-Emote-Version: 1",
      "X-Emote-Version: 1",
      "X-Emote-Session-Id: sess-a",
      "X-Emote-Stream-Id: stream-a",
      "X-Emote-Sequence: 5",
    ]);
    assert.match(dupVersion, /^HTTP\/1\.1 400/);
    // A repeated session header cannot become valid identity; the frame stays display-only.
    const dupSession = await rawRequest(port, png, [
      "Content-Type: image/png",
      "X-Emote-Version: 1",
      "X-Emote-Session-Id: sess-a",
      "X-Emote-Session-Id: sess-a",
      "X-Emote-Stream-Id: stream-a",
      "X-Emote-Sequence: 5",
    ]);
    assert.match(dupSession, /^HTTP\/1\.1 204/);
    assert.ok(server.lastFrame);
    assert.equal(server.lastFrame.focusCapable, false);
    assert.equal(server.sessions.press("sess-a", "stream-a"), null);
  });
});

test("a full session capacity answers 429 for focus-capable frames without evicting live ones", async () => {
  await withServer(async (server, url) => {
    for (let index = 1; index <= 32; index += 1) {
      const response = await fetch(url, { method: "POST", headers: focusHeaders({ session: `s${index}`, sequence: 1 }), body: framePng() });
      assert.equal(response.status, 204);
    }
    const overflow = await fetch(url, { method: "POST", headers: focusHeaders({ session: "s33", sequence: 1 }), body: framePng() });
    assert.equal(overflow.status, 429);
    const payload = await overflow.json();
    assert.equal(typeof payload.error, "string");
    assert.equal(server.lastFrame.sessionId, "s32"); // the 429 frame was not stored
    // Live sessions were not evicted: the first session still carries fresh traffic.
    const stillLive = await fetch(url, { method: "POST", headers: focusHeaders({ session: "s1", sequence: 2 }), body: framePng() });
    assert.equal(stillLive.status, 204);
    assert.ok(server.sessions.press("s1", "stream-a"));
    // Legacy display frames stay accepted even while the focus capacity is full.
    const legacy = await fetch(url, { method: "POST", headers: headers(), body: framePng(64, [7, 7, 7, 255]) });
    assert.equal(legacy.status, 204);
    assert.equal(server.lastFrame.sessionId, null);
  });
});

test("a takeover clears any pending focus request", async () => {
  await withServer(async (server, url) => {
    await fetch(url, { method: "POST", headers: focusHeaders({ sequence: 1 }), body: framePng() });
    server.sessions.press("sess-a", "stream-a");
    const takeover = await fetch(url, { method: "POST", headers: focusHeaders({ stream: "stream-b", sequence: 1 }), body: framePng() });
    assert.equal(takeover.status, 204);
    assert.equal(takeover.headers.get("x-emote-focus-request-id"), null);
    const fresh = await fetch(url, { method: "POST", headers: focusHeaders({ stream: "stream-b", sequence: 2 }), body: framePng() });
    assert.equal(fresh.headers.get("x-emote-focus-request-id"), null);
  });
});

test("a blocked heartbeat reactivation answers 429 and mutates nothing", async () => {
  const clock = fakeClock();
  await withServer(async (server, url) => {
    for (let index = 1; index <= 32; index += 1)
      await fetch(url, { method: "POST", headers: focusHeaders({ session: `s${index}`, sequence: 1 }), body: framePng() });
    clock.advance(30_001); // every lease expired, records retained
    for (let index = 2; index <= 33; index += 1) {
      const reactivated = await fetch(url, { method: "POST", headers: focusHeaders({ session: `s${index}`, sequence: 2 }), body: framePng() });
      assert.equal(reactivated.status, 204);
    }
    const blocked = await fetch(`${url}/heartbeat`, { method: "POST", headers: lifecycleHeaders({ session: "s1", sequence: 2 }), body: Buffer.alloc(0) });
    assert.equal(blocked.status, 429);
    const payload = await blocked.json();
    assert.equal(typeof payload.error, "string");
    // The rejected packet left the record unchanged: an older sequence still replays.
    const stale = await fetch(`${url}/heartbeat`, { method: "POST", headers: lifecycleHeaders({ session: "s1", sequence: 1 }), body: Buffer.alloc(0) });
    assert.equal(stale.status, 204);
  }, { now: clock.now });
});

test("an error avatar status does not block focus", async () => {
  await withServer(async (server, url) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...focusHeaders({ sequence: 1 }), "x-emote-status": "error" },
      body: framePng(),
    });
    assert.equal(response.status, 204);
    assert.ok(server.sessions.press("sess-a", "stream-a"));
  });
});
