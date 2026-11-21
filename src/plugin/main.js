"use strict";

// Wires the loopback receivers to the D200 keys. Every configured port gets its own
// receiver group: keys sharing a configured port mirror that group's newest frame, keys
// on different ports are independent, and a taken fixed port shows an error on exactly
// the keys that requested it. Pressing a key only redraws it, because this plugin is a
// display client for now.
const { appendFileSync, statSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { HostClient } = require("./host-client.js");
const { EmoteServer } = require("./emote-server.js");
const { normalizeSettings } = require("./settings.js");
const { frameDataUri, placeholderDataUri } = require("./presentation.js");

const PLUGIN_UUID = "com.arkamax404.ulanzi.gentleemote";
const MAX_RENDER_CACHE = 8;
const LOG_FILE = join(tmpdir(), "gentle-emote-d200.log");
const MAX_LOG_BYTES = 200 * 1024;

/**
 * Best-effort diagnostic log. Ulanzi Studio swallows plugin stdout, so the only way to see
 * what the key pipeline did is a bounded file. It never throws and never blocks delivery.
 */
function createFileLog(file = LOG_FILE) {
  let truncated = false;
  return (message) => {
    try {
      if (!truncated) {
        truncated = true;
        try {
          if (statSync(file).size > MAX_LOG_BYTES) writeFileSync(file, "");
        } catch {
          /* a missing log file is the normal first run */
        }
      }
      appendFileSync(file, `${new Date().toISOString()} ${message}
`);
    } catch {
      /* diagnostics must never break the key */
    }
  };
}

class EmoteKeyRuntime {
  constructor({ host, server = null, log = console, logLine = () => {} } = {}) {
    if (!host) throw new Error("a key host is required");
    this.host = host;
    // An injected receiver (tests and single-receiver hosts) is reused for its configured
    // port; without one every port group creates its own receiver when first needed.
    this.server = server;
    this.log = log;
    this.logLine = logLine;
    this.contexts = new Map();
    // configured port -> { port, cacheId, server, ready }; render entries are cached per group.
    this.groups = new Map();
    this.groupSequence = 0; // unique per group lifetime: equal frame ids of a recreated
    // same-port receiver must not hit the retired group's render cache entries
    this.closing = new Map(); // configured port -> in-flight stop promise of a removed group
    this.cache = new Map();
    this.started = false;
  }

  async start() {
    if (this.started) return this;
    this.started = true;
    this.host.onAdd((message) => this.applyContext(message));
    this.host.onParamFromApp((message) => this.applyContext(message));
    this.host.onParamFromPlugin((message) => this.applyContext(message));
    this.host.onSetActive((message) => this.setActive(message));
    this.host.onRun((message) => this.onRun(message?.context));
    this.host.onClear((message) => this.clear(message));
    // A dependency-injected receiver gets its group bound up front; production creates
    // each port group when the first key referencing that port is placed.
    if (this.server) await this.ensureGroup(this.server.requestedPort);
    return this;
  }

  applyContext(message) {
    const context = message?.context;
    if (!context) return;
    const entry = this.contexts.get(context) || { active: true, settings: undefined, displayed: null, port: undefined };
    const previousPort = entry.port;
    entry.settings = normalizeSettings({ ...entry.settings, ...(message.param || {}) });
    entry.port = entry.settings.port;
    if (previousPort !== undefined && previousPort !== entry.port)
      entry.displayed = null; // the old receiver's frame/focus identity does not follow the key
    this.contexts.set(context, entry);
    void this.ensureGroup(entry.port).then(() => {
      if (previousPort !== undefined && previousPort !== entry.port) this.afterContextsChanged();
    });
    this.redraw(context);
  }

  /** The receiver for one configured port; created once and shared by all of its keys. */
  ensureGroup(port) {
    const existing = this.groups.get(port);
    if (existing) return existing.ready;
    const previousClose = this.closing.get(port);
    const group = { port, cacheId: ++this.groupSequence, server: null, ready: null };
    this.groups.set(port, group);
    group.ready = (async () => {
      try {
        await previousClose; // a removed receiver on this port closes before the next binds
        if (this.groups.get(port) !== group) return; // removed while the old one was closing
        group.server = this.createServer(port);
        this.wireGroup(group);
        let bound = null;
        if (!group.server.listening) {
          bound = await group.server.start();
          this.logLine(
            bound.target
              ? `receiver bound: ${bound.target}`
              : `receiver blocked: port ${bound.requestedPort} unavailable`,
          );
        } else {
          this.logLine(`receiver bound: ${group.server.target}`);
        }
        // The group may have lost its last key while the bind was in flight.
        if (this.groups.get(port) !== group) {
          await group.server.stop();
          return;
        }
        this.renderGroup(port);
      } catch (error) {
        this.log.error(`[gentle-emote] receiver: ${error.message}`);
      }
    })();
    return group.ready;
  }

  createServer(port) {
    if (this.server && this.server.requestedPort === port) return this.server;
    return new EmoteServer({ port });
  }

  wireGroup(group) {
    const port = group.port;
    group.handlers = [
      ["frame", (frame) => this.onFrame(port, frame)],
      [
        "diagnostic",
        (diagnostic) => {
          this.log.log(`[gentle-emote] ${diagnostic.message || diagnostic.code}`);
          this.logLine(`receiver diagnostic: ${diagnostic.message || diagnostic.code}`);
          this.renderGroup(port);
        },
      ],
      [
        "error",
        (error) => {
          this.log.error(`[gentle-emote] receiver: ${error.message}`);
          this.logLine(`receiver error: ${error.message}`);
        },
      ],
    ];
    for (const [event, handler] of group.handlers) group.server.on(event, handler);
  }

  unwireGroup(group) {
    for (const [event, handler] of group.handlers || []) group.server.removeListener(event, handler);
  }

  /** Stops one group's receiver and remembers the close so a same-port rebinding waits for it. */
  removeGroup(port) {
    const group = this.groups.get(port);
    if (!group) return Promise.resolve();
    this.groups.delete(port);
    let closing = this.closing.get(port);
    if (group.server) {
      this.unwireGroup(group);
      closing = (closing ?? Promise.resolve()).then(() => group.server.stop());
      closing.catch(() => {});
      closing.then(() => {
        if (this.closing.get(port) === closing) this.closing.delete(port);
      });
      this.closing.set(port, closing);
    }
    return closing ?? Promise.resolve();
  }

  /** Receivers whose last key is gone are stopped; other port groups keep serving. */
  afterContextsChanged() {
    for (const port of [...this.groups.keys()])
      if (![...this.contexts.values()].some((entry) => entry.port === port)) this.removeGroup(port);
  }

  setActive(message) {
    const entry = this.contexts.get(message?.context);
    if (!entry) return;
    entry.active = message.active === true || message.active === "true";
    if (entry.active) this.redraw(message.context);
  }

  /**
   * A key press repaints the newest frame of the key's own port group (legacy behaviour)
   * and, for an existing active key, queues a focus request for the identity the key
   * already showed before the press — never for whatever the group happens to hold at
   * press time. Unknown keys, inactive keys and legacy frames never queue focus, and a
   * queued no-op results when the painted identity has meanwhile retired, closed or
   * expired. Displays are per port group, so the queue used is the key's own.
   */
  onRun(context) {
    const entry = this.contexts.get(context);
    // Snapshot the focus target before any repaint: only a successfully painted
    // focus-capable frame established it, so the press follows what is on screen.
    const displayed = entry && entry.active && entry.displayed ? { ...entry.displayed } : null;
    try {
      this.redraw(context);
    } catch {
      /* a failing paint must never break the focus press itself */
    }
    if (!displayed) return;
    const server = this.groups.get(entry.port)?.server;
    const id = server?.sessions?.press(displayed.session, displayed.stream) ?? null;
    if (id) this.logLine(`focus queued: ${context} session=${displayed.session} id=${id}`);
  }

  /** A key press has no other behaviour beyond showing the newest frame (spec S3). */
  redraw(context) {
    const entry = this.contexts.get(context);
    if (!entry || !entry.active) return;
    const server = this.groups.get(entry.port)?.server;
    if (!server) return; // the receiver for this port is being created; the bind pass paints
    const group = this.groups.get(entry.port);
    const frame = server.lastFrame;
    const blocked = server.blockedPort;
    if (!blocked && !frame && !server.listening) return; // before the bind there is no address to show
    let data;
    if (blocked != null) {
      // A strict fixed port that could not be bound: clear, visible error, never a stale frame.
      data = placeholderDataUri({
        target: `http://${server.host}:${blocked}/emote`,
        detail: "PORT IN USE",
        settings: entry.settings,
      });
    } else if (frame) {
      data = this.frameUri(group, frame, entry.settings);
    } else {
      data = placeholderDataUri({ target: server.target, settings: entry.settings });
    }
    this.logLine(`icon -> ${context} ${data.slice(0, 26)} ${data.length}b mode=${entry.settings.scaleMode}`);
    try {
      this.host.setBaseDataIcon(context, data);
    } catch {
      // The paint failed: the key still shows the previous image, so its last
      // successfully painted identity stays valid and untouched.
      return;
    }
    // The displayed identity is recorded only after the paint actually succeeded, and it
    // is whatever went on screen — not a group-wide lastFrame guess made at press time.
    entry.displayed = frame && !blocked && frame.focusCapable && frame.sessionId && frame.streamId
      ? { session: frame.sessionId, stream: frame.streamId }
      : null;
  }

  renderGroup(port) {
    for (const [context, entry] of this.contexts) if (entry.port === port) this.redraw(context);
  }

  onFrame(port, frame) {
    if (frame) this.logLine(`frame ${frame.id} state=${frame.state} seq=${frame.sequence} bytes=${frame.bytes}`);
    this.renderGroup(port);
  }

  /** Rendering is cached per receiver-group lifetime, frame and settings so a burst of keys
   * reuses one encode; the group identity (not the port) is what keeps equal frame ids of
   * a recreated receiver — and of different receivers — apart.
   */
  frameUri(group, frame, settings) {
    const cacheKey = `${group.cacheId}:${frame.id}:${settings.scaleMode}:${settings.backgroundColor}:${settings.backgroundTransparency}:${settings.removeBlackBackground}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const data = frameDataUri(frame, settings);
    if (this.cache.size >= MAX_RENDER_CACHE) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(cacheKey, data);
    return data;
  }

  clear(message) {
    for (const item of message?.param || []) this.contexts.delete(item.context);
    this.afterContextsChanged();
  }

  async stop() {
    this.contexts.clear();
    this.cache.clear();
    await Promise.all([...this.groups.keys()].map((port) => this.removeGroup(port)));
    this.started = false;
  }
}

function start() {
  const host = new HostClient();
  const runtime = new EmoteKeyRuntime({ host, logLine: createFileLog() });
  void runtime.start();
  host.connect(PLUGIN_UUID);
  host.on("error", (error) => console.error(`[Ulanzi host] ${error.message}`));
  const shutdown = () => {
    void runtime.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return runtime;
}

if (require.main === module) start();

module.exports = { EmoteKeyRuntime, LOG_FILE, MAX_RENDER_CACHE, PLUGIN_UUID, createFileLog, start };
