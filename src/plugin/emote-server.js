"use strict";

// Loopback HTTP receiver for the gentle-emote external-display protocol v1.
// It keeps only the newest frame: the sender already drops intermediate animations,
// so the key always shows the latest selection instead of a backlog.
const http = require("node:http");
const EventEmitter = require("node:events");
const { MAX_BODY_BYTES, parseEmoteRequest, parseLifecycleRequest } = require("./emote-protocol.js");
const { FocusSessions } = require("./focus-sessions.js");
const { decodePng } = require("./png.js");

// 8003 is the port gentle-emote's /emote d200On targets; 8000 is the simulator and the ESP32 uses 80.
const DEFAULT_PORT = 8003;
const PORT_ATTEMPTS = 10;

class EmoteServer extends EventEmitter {
  constructor(options = {}) {
    super();
    const port = options.port === undefined ? DEFAULT_PORT : options.port;
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${port}`);
    this.host = typeof options.host === "string" ? options.host : "127.0.0.1";
    this.maxBodyBytes = Number.isInteger(options.maxBodyBytes) ? options.maxBodyBytes : MAX_BODY_BYTES;
    this.now = typeof options.now === "function" ? options.now : undefined;
    this.requestedPort = port;
    this.port = 0;
    this.fallback = false;
    this.lastFrame = null;
    this.server = null;
    this.stopped = true;
    this.frameCount = 0;
    // Every start/stop is a new epoch: late in-flight requests may not mutate focus state.
    this.generation = 0;
    this.sessions = new FocusSessions({ now: this.now, requestId: options.requestId });
  }

  get listening() {
    return this.server !== null && this.server.listening === true;
  }

  /** The URL to give gentle-emote's `externalDisplay.url`, with the port actually bound. */
  get target() {
    return this.port ? `http://${this.host}:${this.port}/emote` : null;
  }

  /** Changes the port the next bind will ask for; restart the receiver to apply it. */
  setPort(port) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${port}`);
    this.requestedPort = port;
  }

  /** Binds the receiver. A requested port that is already taken is not fatal: the next free
   * port of the series is used and announced through `diagnostic`, so a simulator or another
   * instance can own 8003 without breaking the key.
   */
  async start() {
    this.stopped = false;
    this.generation += 1; // restart: focus state starts clean
    this.sessions.stop();
    await this.bind();
    return { host: this.host, port: this.port, requestedPort: this.requestedPort, fallback: this.fallback, target: this.target };
  }

  candidates() {
    if (this.requestedPort === 0) return [0];
    const series = [];
    for (let offset = 0; offset <= PORT_ATTEMPTS; offset += 1)
      if (this.requestedPort + offset <= 65535) series.push(this.requestedPort + offset);
    series.push(0); // Last resort: any free port the OS hands out.
    return series;
  }

  async bind() {
    if (this.server || this.stopped) return;
    for (const port of this.candidates()) {
      try {
        const bound = await this.listen(port);
        this.port = bound;
        // Port 0 means "let the OS choose", so the chosen port is never a fallback.
        this.fallback = this.requestedPort !== 0 && bound !== this.requestedPort;
        if (this.fallback)
          this.diagnostic({
            code: "port-in-use",
            requestedPort: this.requestedPort,
            port: bound,
            message: `port ${this.requestedPort} is unavailable; listening on ${bound}`,
          });
        return;
      } catch (error) {
        this.server = null;
        if (error.code === "EADDRINUSE") continue; // Announced once, as the chosen fallback below.
        if (error.code !== "EACCES") return this.fail(error);
        this.diagnostic(error);
      }
    }
    this.port = 0;
  }

  listen(port) {
    return new Promise((resolve, reject) => {
      const server = http.createServer({ keepAlive: false }, (request, response) => this.handle(request, response));
      const onError = (error) => {
        server.removeListener("listening", onListening);
        server.close(() => reject(error));
      };
      const onListening = () => {
        server.removeListener("error", onError);
        server.on("error", (error) => this.fail(error));
        this.server = server;
        resolve(server.address().port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, this.host);
    });
  }

  /** Non-fatal conditions (a busy port) are data, not crashes. */
  diagnostic(detail) {
    try {
      this.emit("diagnostic", detail);
    } catch {
      /* a failing listener must not break the receiver */
    }
  }

  fail(error) {
    try {
      if (this.listenerCount("error") > 0) this.emit("error", error);
      else console.error(`[gentle-emote] receiver error: ${error.message}`);
    } catch {
      /* a failing listener must not break the receiver */
    }
    this.stopped = true;
    return undefined;
  }

  async stop() {
    this.stopped = true;
    this.generation += 1; // late in-flight requests may no longer mutate focus state
    this.sessions.stop(); // stop and port rebinding always clear focus state
    const server = this.server;
    this.server = null;
    this.port = 0;
    if (!server) return;
    await new Promise((resolve) => server.close(() => resolve()));
  }

  handle(request, response) {
    const generation = this.generation;
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      // Keep draining a rejected body so the sender receives the 413 instead of a reset.
      if (size > this.maxBodyBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", () => {
      if (!response.writableEnded) response.destroy();
    });
    request.on("end", () => {
      if (tooLarge) return this.respond(response, 413, "frame too large");
      this.accept(request, Buffer.concat(chunks), response, generation);
    });
  }

  accept(request, body, response, generation) {
    if (generation !== this.generation) return; // the receiver moved on; never touch focus
    const url = String(request.url || "/");
    const path = url.split("?")[0];
    // Only the exact lifecycle routes without a query are lifecycle packets; anything else
    // (including query strings there) falls through to the frame route.
    if (!url.includes("?") && (path === "/emote/heartbeat" || path === "/emote/close"))
      return this.lifecycle(path, request, body, response);
    const parsed = parseEmoteRequest({ method: request.method, headers: request.headers, rawHeaders: request.rawHeaders, body });
    if (!parsed.ok) {
      if (parsed.allow) response.setHeader("Allow", parsed.allow);
      return this.respond(response, parsed.status, parsed.reason);
    }
    let image;
    try {
      // The PNG decodes before any session transition: an invalid frame never changes state.
      image = decodePng(parsed.frame.png);
    } catch (error) {
      return this.respond(response, 400, `cannot decode PNG: ${error.message}`);
    }
    const focusCapable =
      !parsed.duplicateIdentity &&
      !parsed.originPresent &&
      parsed.frame.sessionId !== null &&
      parsed.frame.streamId !== null &&
      parsed.frame.sequenceRaw !== null;
    if (focusCapable) {
      const outcome = this.sessions.acceptFrame({
        session: parsed.frame.sessionId,
        stream: parsed.frame.streamId,
        sequence: BigInt(parsed.frame.sequenceRaw),
      });
      if (outcome.outcome === "full") return this.respond(response, 429, "focus session capacity reached");
      // Replay, retired or closed traffic is an empty 204 that stores and announces nothing.
      if (outcome.outcome !== "fresh") return this.respond(response, 204, null);
      return this.acceptFreshFrame({ request, response, parsed, image, focusRequestId: this.resolveAck(request, parsed.frame.sessionId, outcome.request) });
    }
    return this.acceptFreshFrame({ request, response, parsed, image, focusRequestId: null, focusCapable: false });
  }

  /** A matching ack consumes the queued request; malformed or unknown acks are ignored. */
  resolveAck(request, session, queuedId) {
    const ackHeader = request.headers?.["x-emote-focus-ack"];
    const ack = typeof ackHeader === "string" ? ackHeader.trim() : null;
    if (ack === null || !session || !queuedId) return queuedId;
    return this.sessions.ack({ session, id: ack }) ? null : queuedId;
  }

  acceptFreshFrame({ response, parsed, image, focusRequestId, focusCapable = true }) {
    const frame = {
      ...parsed.frame,
      image,
      bytes: parsed.frame.png.length,
      receivedAt: Date.now(),
      id: ++this.frameCount,
      focusCapable,
    };
    this.lastFrame = frame;
    this.respond(response, 204, null, focusRequestId ? { "x-emote-focus-request-id": focusRequestId } : undefined);
    try {
      this.emit("frame", frame);
    } catch {
      /* a failing key must not break delivery */
    }
  }

  lifecycle(path, request, body, response) {
    const parsed = parseLifecycleRequest({ method: request.method, headers: request.headers, rawHeaders: request.rawHeaders, body });
    if (!parsed.ok) {
      if (parsed.allow) response.setHeader("Allow", parsed.allow);
      return this.respond(response, parsed.status, parsed.reason);
    }
    const result = path === "/emote/heartbeat"
      ? this.sessions.heartbeat(parsed.identity)
      : this.sessions.close(parsed.identity);
    if (result.outcome === "full") return this.respond(response, 429, "focus session capacity reached");
    const queuedId = result.outcome === "fresh" ? this.resolveAck(request, parsed.identity.session, result.request) : null;
    this.respond(response, 204, null, queuedId ? { "x-emote-focus-request-id": queuedId } : undefined);
  }

  respond(response, status, error, extraHeaders) {
    if (response.writableEnded) return;
    if (error === null) {
      response.writeHead(status, extraHeaders);
      response.end();
      return;
    }
    const payload = Buffer.from(JSON.stringify({ error }));
    response.writeHead(status, { "content-type": "application/json", "content-length": payload.length });
    response.end(payload);
  }
}

module.exports = { DEFAULT_PORT, PORT_ATTEMPTS, EmoteServer };
