const assert = require("node:assert/strict");
const test = require("node:test");
const { EmoteKeyRuntime } = require("../src/plugin/main.js");
const { EmoteServer } = require("../src/plugin/emote-server.js");
const { decodePng } = require("../src/plugin/png.js");
const { encodePng } = require("../src/plugin/png.js");
const { KEY_SIZE } = require("../src/plugin/scale.js");

function framePng(size = 64, color = [40, 90, 200, 255]) {
  const data = new Uint8Array(size * size * 4);
  for (let index = 0; index < size * size; index += 1) data.set(color, index * 4);
  return encodePng({ width: size, height: size, data });
}

/** A frame with an opaque black edge ring around a coloured centre. */
function borderedFramePng(size = 64, color = [40, 90, 200, 255]) {
  const data = new Uint8Array(size * size * 4);
  for (let index = 0; index < size * size; index += 1) {
    const x = index % size;
    const y = Math.floor(index / size);
    data.set(x === 0 || y === 0 || x === size - 1 || y === size - 1 ? [0, 0, 0, 255] : color, index * 4);
  }
  return encodePng({ width: size, height: size, data });
}

function emoteHeaders(sequence = 1) {
  return {
    "content-type": "image/png",
    "x-emote-version": "1",
    "x-emote-state": "think",
    "x-emote-frame": "think.png",
    "x-emote-set": "gentleman",
    "x-emote-status": "busy",
    "x-emote-phase": "thinking",
    "x-emote-active-subagents": "0",
    "x-emote-stream-id": "stream-test",
    "x-emote-sequence": String(sequence),
  };
}

function createStubHost() {
  const handlers = new Map();
  const icons = [];
  const register = (name) => (handler) => handlers.set(name, handler);
  return {
    icons,
    onAdd: register("add"),
    onParamFromApp: register("paramfromapp"),
    onParamFromPlugin: register("paramfromplugin"),
    onSetActive: register("setactive"),
    onRun: register("run"),
    onClear: register("clear"),
    setBaseDataIcon: (context, data) => icons.push({ context, data }),
    setStateIcon: () => {},
    emit: (name, message) => handlers.get(name)?.(message),
    last: () => icons[icons.length - 1],
  };
}

function createLog() {
  const lines = [];
  return {
    lines,
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
  };
}

async function waitFor(condition, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met in time");
}

async function startRuntime(options = {}) {
  const host = createStubHost();
  const log = createLog();
  const server = new EmoteServer({ port: 0, ...options });
  const runtime = new EmoteKeyRuntime({ host, server, log, ...options });
  await runtime.start();
  return { host, log, server, runtime };
}

// --- focus activation helpers (task T2/S1) ---

function focusHeaders({ session = "sess-a", stream = "stream-a", sequence = 1 } = {}) {
  return {
    "content-type": "image/png",
    "x-emote-version": "1",
    "x-emote-session-id": session,
    "x-emote-stream-id": stream,
    "x-emote-sequence": String(sequence),
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

/** A key icon is an SVG payload that embeds the scaled 196x196 PNG. */
function keyPng(uri) {
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
  const base64 = /href="data:image\/png;base64,([A-Za-z0-9+/=]+)"/.exec(svg)[1];
  return decodePng(Buffer.from(base64, "base64"));
}

test("a placed key shows the receiving URL until a frame arrives", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    const icon = host.last();
    assert.equal(icon.context, "key-1");
    const svg = Buffer.from(icon.data.split(",")[1], "base64").toString("utf8");
    assert.match(svg, new RegExp(`127\\.0\\.0\\.1:${server.port}`));
  } finally {
    await runtime.stop();
  }
});

test("a received frame is mirrored on every placed key", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    host.emit("add", { context: "key-2", param: { port: 0 } });
    const response = await fetch(`http://127.0.0.1:${server.port}/emote`, {
      method: "POST",
      headers: emoteHeaders(),
      body: framePng(),
    });
    assert.equal(response.status, 204);
    // Placeholders are SVG too, so wait for icons that carry an embedded frame PNG.
    const frameIcons = () => host.icons.filter((icon) => {
      if (!icon.data.startsWith("data:image/svg+xml")) return false;
      return Buffer.from(icon.data.split(",")[1], "base64").toString("utf8").includes('href="data:image/png;base64,');
    });
    await waitFor(() => frameIcons().length >= 2);
    assert.deepEqual([...new Set(frameIcons().map((icon) => icon.context))].sort(), ["key-1", "key-2"]);
    for (const icon of frameIcons()) {
      const png = keyPng(icon.data);
      assert.equal(png.width, KEY_SIZE);
      assert.equal(png.height, KEY_SIZE);
      const center = (96 * KEY_SIZE + 96) * 4;
      assert.deepEqual([...png.data.subarray(center, center + 4)], [40, 90, 200, 255]);
    }
  } finally {
    await runtime.stop();
  }
});

test("pressing the key only redraws the newest frame", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    await fetch(`http://127.0.0.1:${server.port}/emote`, { method: "POST", headers: emoteHeaders(), body: framePng() });
    await waitFor(() => host.icons.some((icon) => icon.data.startsWith("data:image/svg+xml")));
    const before = host.icons.filter((icon) => icon.data.startsWith("data:image/svg+xml")).length;
    const frameCount = server.frameCount;
    host.emit("run", { context: "key-1" });
    const rendered = host.icons.filter((icon) => icon.data.startsWith("data:image/svg+xml"));
    assert.equal(rendered.length, before + 1);
    assert.equal(server.frameCount, frameCount);
    assert.equal(rendered[rendered.length - 1].data, rendered[rendered.length - 2].data);
  } finally {
    await runtime.stop();
  }
});

test("an inactive key stops receiving frames until it is active again", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    await waitFor(() => host.icons.length === 1);
    host.emit("setactive", { context: "key-1", active: false });
    const iconsWhileInactive = host.icons.length;
    await fetch(`http://127.0.0.1:${server.port}/emote`, { method: "POST", headers: emoteHeaders(2), body: framePng() });
    assert.equal(host.icons.length, iconsWhileInactive);
    host.emit("setactive", { context: "key-1", active: true });
    assert.equal(host.icons.length, iconsWhileInactive + 1);
    assert.ok(host.last().data.startsWith("data:image/svg+xml"));
  } finally {
    await runtime.stop();
  }
});

test("a scale mode change re-renders the newest frame", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    await fetch(`http://127.0.0.1:${server.port}/emote`, { method: "POST", headers: emoteHeaders(), body: framePng() });
    await waitFor(() => host.icons.some((icon) => icon.data.startsWith("data:image/svg+xml")));
    const pixel = host.last().data;
    host.emit("paramfromapp", { context: "key-1", param: { port: 0, scaleMode: "fill" } });
    const fill = host.last().data;
    assert.notEqual(pixel, fill);
    const png = keyPng(fill);
    assert.deepEqual([...png.data.subarray(0, 4)], [40, 90, 200, 255]);
  } finally {
    await runtime.stop();
  }
});

test("a background settings change re-renders the newest frame", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    await fetch(`http://127.0.0.1:${server.port}/emote`, { method: "POST", headers: emoteHeaders(), body: framePng() });
    await waitFor(() => host.icons.some((icon) => icon.data.startsWith("data:image/svg+xml")));
    const before = host.last().data;
    host.emit("paramfromapp", { context: "key-1", param: { port: 0, backgroundColor: "#112233" } });
    const after = host.last().data;
    assert.notEqual(before, after);
    // The letterbox margin now carries the configured background colour, still opaque.
    const png = keyPng(after);
    assert.deepEqual([...png.data.subarray(0, 4)], [0x11, 0x22, 0x33, 255]);
    void runtime;
  } finally {
    await runtime.stop();
  }
});

test("a background transparency change re-renders with transparent margins", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    await fetch(`http://127.0.0.1:${server.port}/emote`, { method: "POST", headers: emoteHeaders(), body: framePng() });
    await waitFor(() => host.icons.some((icon) => icon.data.startsWith("data:image/svg+xml")));
    host.emit("paramfromplugin", { context: "key-1", param: { port: 0, backgroundTransparency: 100 } });
    const png = keyPng(host.last().data);
    // Fully transparent background: the margins carry alpha 0, the opaque source stays visible.
    assert.deepEqual([...png.data.subarray(0, 4)], [0, 0, 0, 0]);
    const center = (96 * KEY_SIZE + 96) * 4;
    assert.deepEqual([...png.data.subarray(center, center + 4)], [40, 90, 200, 255]);
  } finally {
    await runtime.stop();
  }
});

test("background settings persist across later parameter updates", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0, backgroundColor: "#abcdef", backgroundTransparency: 30 } });
    host.emit("paramfromapp", { context: "key-1", param: { port: 0, scaleMode: "fill" } });
    assert.equal(runtime.contexts.get("key-1").settings.backgroundColor, "#abcdef");
    assert.equal(runtime.contexts.get("key-1").settings.backgroundTransparency, 30);
    assert.equal(runtime.contexts.get("key-1").settings.scaleMode, "fill");
  } finally {
    await runtime.stop();
  }
});

test("the no-frame placeholder honours the configured background", async () => {
  // Envelope shape as the Ulanzi host delivers it on add: the stored ActionParam.
  // Regression: the user set #ffaa00 / 37% and the key stayed black because the
  // waiting placeholder ignored the background settings.
  const { host, runtime } = await startRuntime();
  try {
    host.emit("add", {
      context: "key-1",
      param: { port: 0, scaleMode: "pixel", backgroundColor: "#ffaa00", backgroundTransparency: 37 },
    });
    const icon = host.last();
    assert.equal(icon.context, "key-1");
    const svg = Buffer.from(icon.data.split(",")[1], "base64").toString("utf8");
    assert.match(svg, /fill="rgb\(255,170,0\)"/);
    assert.match(svg, /fill-opacity="0\.63"/);
  } finally {
    await runtime.stop();
  }
});

test("a key is not painted before the receiver has an address", async () => {
  const host = createStubHost();
  const runtime = new EmoteKeyRuntime({ host, server: new EmoteServer({ port: 0 }), log: createLog() });
  try {
    runtime.contexts.set("key-1", { active: true, settings: { port: 0, scaleMode: "pixel" } });
    runtime.redraw("key-1");
    assert.equal(host.icons.length, 0);
    await runtime.server.start();
    runtime.redraw("key-1");
    assert.equal(host.icons.length, 1);
    const svg = Buffer.from(host.icons[0].data.split(",")[1], "base64").toString("utf8");
    assert.match(svg, new RegExp(`127\.0\.0\.1:${runtime.server.port}`));
  } finally {
    await runtime.stop();
  }
});

test("toggling the black-removal setting re-renders with a distinct cached payload", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0, backgroundColor: "#112233" } });
    await fetch(`http://127.0.0.1:${server.port}/emote`, { method: "POST", headers: emoteHeaders(), body: borderedFramePng() });
    await waitFor(() => host.icons.some((icon) => {
      if (!icon.data.startsWith("data:image/svg+xml")) return false;
      return Buffer.from(icon.data.split(",")[1], "base64").toString("utf8").includes('href="data:image/png;base64,');
    }));
    const before = host.last().data;
    host.emit("paramfromapp", { context: "key-1", param: { port: 0, backgroundColor: "#112233", removeBlackBackground: true } });
    const after = host.last().data;
    assert.notEqual(before, after);
    // The removed edge ring now carries the configured background instead of opaque black.
    const png = keyPng(after);
    assert.deepEqual([...png.data.subarray(0, 4)], [0x11, 0x22, 0x33, 255]);
    // Turning the option off serves the cached legacy payload again.
    host.emit("paramfromapp", { context: "key-1", param: { port: 0, backgroundColor: "#112233", removeBlackBackground: false } });
    assert.equal(host.last().data, before);
  } finally {
    await runtime.stop();
  }
});

test("the black-removal setting persists across later parameter updates", async () => {
  const { host, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0, removeBlackBackground: true } });
    host.emit("paramfromapp", { context: "key-1", param: { port: 0, scaleMode: "fill" } });
    assert.equal(runtime.contexts.get("key-1").settings.removeBlackBackground, true);
    host.emit("paramfromapp", { context: "key-1", param: { port: 0, removeBlackBackground: false } });
    assert.equal(runtime.contexts.get("key-1").settings.removeBlackBackground, false);
    host.emit("paramfromapp", { context: "key-1", param: { port: 0, scaleMode: "pixel" } });
    assert.equal(runtime.contexts.get("key-1").settings.removeBlackBackground, false);
  } finally {
    await runtime.stop();
  }
});

test("removing the last key releases the port", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    const { port } = server;
    assert.equal(server.listening, true);
    host.emit("clear", { param: [{ context: "key-1" }] });
    await waitFor(() => server.listening === false);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/emote`, { method: "POST", headers: emoteHeaders(), body: framePng() }));
  } finally {
    await runtime.stop();
  }
});

test("a busy port falls back and the key shows the port in use", async () => {
  const first = new EmoteServer({ port: 0 });
  await first.start();
  const host = createStubHost();
  const log = createLog();
  const server = new EmoteServer({ port: 0 });
  const runtime = new EmoteKeyRuntime({ host, server, log });
  await runtime.start();
  try {
    host.emit("add", { context: "key-1", param: { port: first.port } });
    await waitFor(() => server.listening && server.port !== first.port);
    await waitFor(() => host.icons.some((icon) => {
      const svg = Buffer.from(icon.data.split(",")[1], "base64").toString("utf8");
      return svg.includes(`127.0.0.1:${server.port}`);
    }));
    assert.ok(log.lines.some((line) => line.includes("unavailable")));
  } finally {
    await runtime.stop();
    await first.stop();
  }
});

// --- focus activation on key press (task T2/S1) ---

async function postFrame(server, overrides = {}, body = framePng()) {
  return fetch(`http://127.0.0.1:${server.port}/emote`, { method: "POST", headers: focusHeaders(overrides), body });
}

async function waitFrameIcon(host) {
  await waitFor(() => host.icons.some((icon) => {
    if (!icon.data.startsWith("data:image/svg+xml")) return false;
    return Buffer.from(icon.data.split(",")[1], "base64").toString("utf8").includes('href="data:image/png;base64,');
  }));
}

test("pressing the key queues focus for exactly the displayed frame's session and stream", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    await postFrame(server, { sequence: 1 });
    await waitFrameIcon(host);
    // Without a press, accepted frames deliver nothing.
    const unrequested = await postFrame(server, { sequence: 2 });
    assert.equal(unrequested.headers.get("x-emote-focus-request-id"), null);
    host.emit("run", { context: "key-1" });
    const requested = await postFrame(server, { sequence: 3 });
    assert.equal(requested.status, 204);
    assert.equal(await requested.text(), "");
    assert.ok(requested.headers.get("x-emote-focus-request-id"));
    // The request follows the session that was on screen, not any other session.
    await postFrame(server, { session: "sess-b", stream: "stream-b", sequence: 1 });
    const other = await fetch(`http://127.0.0.1:${server.port}/emote`, { method: "POST", headers: focusHeaders({ session: "sess-b", stream: "stream-b", sequence: 2 }), body: framePng() });
    assert.equal(other.headers.get("x-emote-focus-request-id"), null);
  } finally {
    await runtime.stop();
  }
});

test("a heartbeat neither repaints the key nor switches the focused identity", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    await postFrame(server, { sequence: 1 });
    await waitFrameIcon(host);
    const iconsAfterFrame = host.icons.length;
    const beat = await fetch(`http://127.0.0.1:${server.port}/emote/heartbeat`, {
      method: "POST",
      headers: { "x-emote-version": "1", "x-emote-session-id": "sess-a", "x-emote-stream-id": "stream-a", "x-emote-sequence": "2" },
      body: Buffer.alloc(0),
    });
    assert.equal(beat.status, 204);
    assert.equal(host.icons.length, iconsAfterFrame);
    host.emit("run", { context: "key-1" });
    const requested = await postFrame(server, { sequence: 3 });
    assert.ok(requested.headers.get("x-emote-focus-request-id"));
  } finally {
    await runtime.stop();
  }
});

test("legacy frames stay visible but can never request, deliver or ack focus", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    await fetch(`http://127.0.0.1:${server.port}/emote`, { method: "POST", headers: emoteHeaders(), body: framePng() });
    await waitFrameIcon(host);
    host.emit("run", { context: "key-1" });
    const response = await postFrame(server, { sequence: 1 });
    assert.equal(response.headers.get("x-emote-focus-request-id"), null);
  } finally {
    await runtime.stop();
  }
});

test("a replay frame does not replace the painted frame identity", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    await postFrame(server, { sequence: 5 });
    await waitFrameIcon(host);
    const iconsAfterFrame = host.icons.length;
    const replayed = await postFrame(server, { sequence: 4 });
    assert.equal(replayed.status, 204);
    assert.equal(host.icons.length, iconsAfterFrame);
    assert.equal(server.lastFrame.sequence, 5);
    host.emit("run", { context: "key-1" });
    const requested = await postFrame(server, { sequence: 6 });
    assert.ok(requested.headers.get("x-emote-focus-request-id"));
  } finally {
    await runtime.stop();
  }
});

test("after a close, pressing the key is a focus no-op", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    await postFrame(server, { sequence: 1 });
    await waitFrameIcon(host);
    const closed = await fetch(`http://127.0.0.1:${server.port}/emote/close`, {
      method: "POST",
      headers: { "x-emote-version": "1", "x-emote-session-id": "sess-a", "x-emote-stream-id": "stream-a", "x-emote-sequence": "2" },
      body: Buffer.alloc(0),
    });
    assert.equal(closed.status, 204);
    host.emit("run", { context: "key-1" });
    // A takeover after the close must not deliver a stale queued request.
    const takeover = await postFrame(server, { stream: "stream-b", sequence: 1 });
    assert.equal(takeover.headers.get("x-emote-focus-request-id"), null);
  } finally {
    await runtime.stop();
  }
});

test("an expired lease makes the press a focus no-op until fresh traffic reactivates", async () => {
  const clock = fakeClock();
  const { host, server, runtime } = await startRuntime({ now: clock.now });
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    await postFrame(server, { sequence: 1 });
    await waitFrameIcon(host);
    const iconsAfterFrame = host.icons.length;
    clock.advance(30_001);
    host.emit("run", { context: "key-1" });
    const requested = await postFrame(server, { sequence: 2 });
    assert.equal(requested.headers.get("x-emote-focus-request-id"), null);
    // The fresh frame reactivated the session and repainted the key.
    await waitFor(() => host.icons.length > iconsAfterFrame);
  } finally {
    await runtime.stop();
  }
});

test("unknown and inactive keys never queue focus", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    await postFrame(server, { sequence: 1 });
    await waitFrameIcon(host);
    host.emit("run", { context: "ghost" });
    host.emit("setactive", { context: "key-1", active: false });
    host.emit("run", { context: "key-1" });
    const response = await postFrame(server, { sequence: 2 });
    assert.equal(response.headers.get("x-emote-focus-request-id"), null);
  } finally {
    await runtime.stop();
  }
});

test("pressing focuses the last successfully painted identity, never the newest frame", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0 } });
    await postFrame(server, { sequence: 1 });
    await waitFrameIcon(host);
    // Fail the paint for key-1: the key stays on what it already shows (sess-a).
    const paint = host.setBaseDataIcon;
    const failPaint = (context, data) => {
      if (context === "key-1") throw new Error("paint failed");
      return paint.call(host, context, data);
    };
    host.setBaseDataIcon = failPaint;
    // A newer LEGACY frame exists; it never reached the key, so it must never become
    // the focus target and the failed paint must not drop the painted identity.
    await fetch(`http://127.0.0.1:${server.port}/emote`, { method: "POST", headers: emoteHeaders(), body: framePng() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The press must not throw and must target the painted identity.
    host.emit("run", { context: "key-1" });
    host.setBaseDataIcon = paint;
    const focused = await postFrame(server, { sequence: 2 });
    assert.ok(focused.headers.get("x-emote-focus-request-id"), "the painted identity must be focused");
    // If that identity retired meanwhile, the press against it is a no-op: nothing is
    // queued and the next frames for the taking-over identity carry no focus id.
    host.setBaseDataIcon = failPaint;
    await postFrame(server, { session: "sess-b", stream: "stream-b", sequence: 1 }); // takeover
    host.emit("run", { context: "key-1" });
    host.setBaseDataIcon = paint;
    const afterRetired = await postFrame(server, { session: "sess-b", stream: "stream-b", sequence: 2 });
    assert.equal(afterRetired.headers.get("x-emote-focus-request-id"), null);
  } finally {
    await runtime.stop();
  }
});
