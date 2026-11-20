"use strict";

// Wires the loopback receiver to the D200 keys. Every placed key mirrors the newest frame;
// pressing a key only redraws it, because this plugin is a display client for now.
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
  constructor({ host, server = new EmoteServer(), log = console, logLine = () => {} } = {}) {
    if (!host) throw new Error("a key host is required");
    this.host = host;
    this.server = server;
    this.log = log;
    this.logLine = logLine;
    this.contexts = new Map();
    this.cache = new Map();
    this.started = false;
  }

  async start() {
    if (this.started) return this;
    this.started = true;
    this.server.on("frame", (frame) => this.onFrame(frame));
    this.server.on("diagnostic", (diagnostic) => {
      this.log.log(`[gentle-emote] ${diagnostic.message || diagnostic.code}`);
      this.logLine(`receiver diagnostic: ${diagnostic.message || diagnostic.code}`);
      this.renderAll();
    });
    this.server.on("error", (error) => {
      this.log.error(`[gentle-emote] receiver: ${error.message}`);
      this.logLine(`receiver error: ${error.message}`);
    });
    this.host.onAdd((message) => this.applyContext(message));
    this.host.onParamFromApp((message) => this.applyContext(message));
    this.host.onParamFromPlugin((message) => this.applyContext(message));
    this.host.onSetActive((message) => this.setActive(message));
    this.host.onRun((message) => this.redraw(message.context));
    this.host.onClear((message) => this.clear(message));
    await this.server.start();
    this.logLine(`receiver bound: ${this.server.target ?? "none"} (fallback=${this.server.fallback})`);
    this.renderAll();
    return this;
  }

  applyContext(message) {
    const context = message?.context;
    if (!context) return;
    const entry = this.contexts.get(context) || { active: true, settings: undefined };
    entry.settings = normalizeSettings({ ...entry.settings, ...(message.param || {}) });
    this.contexts.set(context, entry);
    void this.ensurePort(entry.settings.port);
    this.redraw(context);
  }

  /** One receiver serves every placed key; the newest configured port wins. */
  async ensurePort(port) {
    if (this.server.listening && this.server.requestedPort === port) return;
    try {
      if (this.server.listening) await this.server.stop();
      this.server.setPort(port);
      await this.server.start();
    } catch (error) {
      this.log.error(`[gentle-emote] receiver: ${error.message}`);
    }
    this.renderAll();
  }

  setActive(message) {
    const entry = this.contexts.get(message?.context);
    if (!entry) return;
    entry.active = message.active === true || message.active === "true";
    if (entry.active) this.redraw(message.context);
  }

  /** A key press has no behaviour beyond showing the newest frame (spec S3). */
  redraw(context) {
    const entry = this.contexts.get(context);
    if (!entry || !entry.active) return;
    const frame = this.server.lastFrame;
    // Before the receiver is bound there is no address to show; the post-bind pass draws it.
    if (!frame && !this.server.target) return;
    const data = frame ? this.frameUri(frame, entry.settings) : this.placeholderUri(entry.settings);
    this.logLine(`icon -> ${context} ${data.slice(0, 26)} ${data.length}b mode=${entry.settings.scaleMode}`);
    this.host.setBaseDataIcon(context, data);
  }

  renderAll() {
    for (const context of this.contexts.keys()) this.redraw(context);
  }

  onFrame(frame) {
    if (frame) this.logLine(`frame ${frame.id} state=${frame.state} seq=${frame.sequence} bytes=${frame.bytes}`);
    this.renderAll();
  }

  /** Rendering is cached per frame and rendering settings so a burst of keys reuses one encode. */
  frameUri(frame, settings) {
    const cacheKey = `${frame.id}:${settings.scaleMode}:${settings.backgroundColor}:${settings.backgroundTransparency}:${settings.removeBlackBackground}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const data = frameDataUri(frame, settings);
    if (this.cache.size >= MAX_RENDER_CACHE) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(cacheKey, data);
    return data;
  }

  placeholderUri(settings) {
    return placeholderDataUri({ target: this.server.target, settings });
  }

  clear(message) {
    for (const item of message?.param || []) this.contexts.delete(item.context);
    if (this.contexts.size === 0) void this.server.stop();
  }

  async stop() {
    this.contexts.clear();
    this.cache.clear();
    await this.server.stop();
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
