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
  const server = new EmoteServer({ port: 0 });
  const runtime = new EmoteKeyRuntime({ host, server, log, ...options });
  await runtime.start();
  return { host, log, server, runtime };
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

test("per-key backgrounds redraw the same frame, isolate cache and retain partial settings", async () => {
  const { host, server, runtime } = await startRuntime();
  try {
    host.emit("add", { context: "key-1", param: { port: 0, scaleMode: "fill", backgroundColor: "#204060" } });
    const svg = Buffer.from(host.last().data.split(",")[1], "base64").toString("utf8");
    assert.match(svg, /fill="#204060"/);
    host.emit("add", { context: "key-2", param: { port: 0, scaleMode: "fill", backgroundColor: "#abcdef" } });
    const response = await fetch(`http://127.0.0.1:${server.port}/emote`, {
      method: "POST", headers: emoteHeaders(), body: framePng(64, [1, 2, 3, 0]),
    });
    assert.equal(response.status, 204);
    const lastFor = (context) => host.icons.filter((icon) => icon.context === context).at(-1).data;
    const corner = (context) => [...keyPng(lastFor(context)).data.subarray(0, 4)];
    assert.deepEqual(corner("key-1"), [32, 64, 96, 255]);
    assert.deepEqual(corner("key-2"), [171, 205, 239, 255]);
    const previous = lastFor("key-1");
    const port = server.port;
    const frameCount = server.frameCount;
    host.emit("paramfromplugin", { context: "key-1", param: { backgroundColor: "#ff0000" } });
    assert.notEqual(lastFor("key-1"), previous);
    assert.deepEqual(corner("key-1"), [255, 0, 0, 255]);
    assert.deepEqual(corner("key-2"), [171, 205, 239, 255]);
    assert.equal(server.port, port);
    assert.equal(server.requestedPort, 0);
    assert.equal(server.frameCount, frameCount);
    // Only colour was sent: fill must remain selected (no letterbox on this opaque frame).
    const opaque = await fetch(`http://127.0.0.1:${server.port}/emote`, {
      method: "POST", headers: emoteHeaders(2), body: framePng(),
    });
    assert.equal(opaque.status, 204);
    assert.deepEqual(corner("key-1"), [40, 90, 200, 255]);
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
