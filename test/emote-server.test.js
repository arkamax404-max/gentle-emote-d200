const assert = require("node:assert/strict");
const test = require("node:test");
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

async function withServer(run) {
  const server = new EmoteServer({ port: 0 });
  await server.start();
  try {
    await run(server, `http://127.0.0.1:${server.port}/emote`);
  } finally {
    await server.stop();
  }
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

test("a busy port falls back to another free port", async () => {
  const first = new EmoteServer({ port: 0 });
  await first.start();
  const second = new EmoteServer({ port: first.port });
  const diagnostics = [];
  second.on("diagnostic", (diagnostic) => diagnostics.push(diagnostic));
  const bound = await second.start();
  try {
    assert.equal(second.listening, true);
    assert.notEqual(bound.port, first.port);
    assert.ok(bound.port > 0);
    assert.equal(bound.requestedPort, first.port);
    assert.equal(bound.fallback, true);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, "port-in-use");
    assert.equal(diagnostics[0].port, bound.port);
    const response = await fetch(`http://127.0.0.1:${bound.port}/emote`, {
      method: "POST",
      headers: headers(),
      body: framePng(),
    });
    assert.equal(response.status, 204);
    assert.ok(second.lastFrame);
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
