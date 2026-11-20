"use strict";

// Bounded focus-session registry for the DEDICATED-SUCCESS-v1 handshake (task T2/S1).
// One simple record per session: the current stream, its exact sequence, the last-seen
// time, a closed flag, up to 16 retired stream ids (FIFO) and one pending focus request.
// Desktop contract bounds: 64 known session records (inactive records evicted by least
// recently seen when a 65th is needed; active records are never evicted), 32
// simultaneously active sessions (lease fresh and not closed; activating a 33rd is
// blocked, including heartbeat reactivations), and a 30s lease and 15s focus TTL.
// The outgoing stream retires FIFO16 whatever its former state; an id dropped from the
// FIFO is simply unknown again and returns through a normal takeover. Close frees the
// active slot immediately but keeps the record for replay protection. Clock injection
// keeps the boundaries deterministic in tests.
const crypto = require("node:crypto");

const FOCUS_TTL_MS = 15_000;
const LEASE_MS = 30_000;
const MAX_ACTIVE_SESSIONS = 32;
const MAX_KNOWN_SESSIONS = 64;
const MAX_RETIRED_PER_SESSION = 16;

/** Opaque, bounded focus request id: 22 chars of base64url. */
function defaultRequestId() {
  return crypto.randomBytes(16).toString("base64url");
}

class FocusSessions {
  constructor({ now = () => Date.now(), requestId } = {}) {
    this.now = typeof now === "function" ? now : () => Date.now();
    this.requestId = typeof requestId === "function" ? requestId : defaultRequestId;
    this.sessions = new Map(); // session -> record
  }

  stop() {
    this.sessions.clear();
  }

  isExpired(rec) {
    return this.now() - rec.lastSeen >= LEASE_MS;
  }

  isActive(rec) {
    return !rec.closed && !this.isExpired(rec);
  }

  countActive() {
    let count = 0;
    for (const rec of this.sessions.values()) if (this.isActive(rec)) count += 1;
    return count;
  }

  /**
   * A fresh PNG carries session identity. Outcomes:
   * fresh (new sequence, takeover or reactivation; may deliver a pending focus request),
   * replay / retired / closed (accepted display traffic that mutates nothing),
   * full (the 32 active capacity is exhausted; the caller answers 429 and stays no-op).
   */
  acceptFrame({ session, stream, sequence }) {
    const rec = this.sessions.get(session);
    if (!rec) return this.createSession(session, stream, sequence);
    if (rec.current === stream) {
      if (rec.closed) return { outcome: "closed" }; // a closed current never revives
      if (sequence <= rec.sequence) return { outcome: "replay" };
      // Reactivating an expired current counts against the 32 active capacity.
      if (this.isExpired(rec) && this.countActive() >= MAX_ACTIVE_SESSIONS) return { outcome: "full" };
      rec.sequence = sequence;
      rec.lastSeen = this.now();
      return { outcome: "fresh", request: this.pendingRequest(rec) };
    }
    if (rec.retired.includes(stream)) return { outcome: "retired" };
    // A brand new stream takes over with any valid sequence, including zero. If the
    // record itself is inactive, the takeover is an activation and needs a free slot.
    if (!this.isActive(rec) && this.countActive() >= MAX_ACTIVE_SESSIONS) return { outcome: "full" };
    this.retireCurrent(rec);
    rec.pending = null; // a takeover always clears the queued focus request
    rec.current = stream;
    rec.sequence = sequence;
    rec.lastSeen = this.now();
    rec.closed = false;
    return { outcome: "fresh", request: null };
  }

  /** Heartbeat refreshes the current stream's lease; it never creates or takes over. */
  heartbeat({ session, stream, sequence }) {
    const rec = this.sessions.get(session);
    if (!rec) return { outcome: "unknown" };
    if (rec.current !== stream)
      return rec.retired.includes(stream) ? { outcome: "retired" } : { outcome: "unknown" };
    if (rec.closed) return { outcome: "closed" };
    if (sequence <= rec.sequence) return { outcome: "replay" };
    if (this.isExpired(rec) && this.countActive() >= MAX_ACTIVE_SESSIONS) return { outcome: "full" };
    rec.sequence = sequence;
    rec.lastSeen = this.now();
    return { outcome: "fresh", request: this.pendingRequest(rec) };
  }

  /** Close frees the active slot immediately and clears focus, but keeps the record. */
  close({ session, stream, sequence }) {
    const rec = this.sessions.get(session);
    if (!rec) return { outcome: "unknown" };
    if (rec.current !== stream)
      return rec.retired.includes(stream) ? { outcome: "retired" } : { outcome: "unknown" };
    if (rec.closed) return { outcome: "closed" };
    if (sequence <= rec.sequence) return { outcome: "replay" };
    rec.closed = true;
    rec.pending = null;
    return { outcome: "closed" };
  }

  /**
   * A key press queues a new opaque focus id for the displayed stream. It is a no-op
   * unless that stream is the record's current stream, not closed and inside its lease.
   */
  press(session, stream) {
    const rec = this.sessions.get(session);
    if (!rec || rec.closed || stream !== rec.current || this.isExpired(rec)) return null;
    const id = this.requestId();
    rec.pending = { id, issuedAt: this.now() };
    return id;
  }

  /** A matching ack consumes the queued request; unknown or stale acks are ignored. */
  ack({ session, id }) {
    const rec = this.sessions.get(session);
    if (!rec || typeof id !== "string" || !rec.pending || rec.pending.id !== id) return false;
    rec.pending = null;
    return true;
  }

  createSession(session, stream, sequence) {
    // A brand new session adds one active record, so the 32 active capacity applies
    // before anything is created: a rejected packet must mutate nothing.
    if (this.countActive() >= MAX_ACTIVE_SESSIONS) return { outcome: "full" };
    if (this.sessions.size >= MAX_KNOWN_SESSIONS) this.evictInactive();
    this.sessions.set(session, {
      current: stream,
      sequence,
      lastSeen: this.now(),
      closed: false,
      retired: [],
      pending: null,
    });
    return { outcome: "fresh", request: null };
  }

  /** Only inactive records are eviction candidates, the least recently seen first. */
  evictInactive() {
    let victim = null;
    for (const [session, rec] of this.sessions) {
      if (this.isActive(rec)) continue;
      if (!victim || rec.lastSeen < victim.rec.lastSeen) victim = { session, rec };
    }
    if (victim) this.sessions.delete(victim.session);
    return this.sessions.size < MAX_KNOWN_SESSIONS;
  }

  /** The outgoing stream retires FIFO16 whatever its former state; overflow drops it. */
  retireCurrent(rec) {
    rec.retired.push(rec.current);
    if (rec.retired.length > MAX_RETIRED_PER_SESSION) rec.retired.shift();
  }

  /** The queued focus id, or null once the 15s TTL from the click has passed. */
  pendingRequest(rec) {
    if (!rec.pending) return null;
    if (this.now() - rec.pending.issuedAt >= FOCUS_TTL_MS) {
      rec.pending = null;
      return null;
    }
    return rec.pending.id;
  }
}

module.exports = {
  FOCUS_TTL_MS,
  LEASE_MS,
  MAX_ACTIVE_SESSIONS,
  MAX_KNOWN_SESSIONS,
  MAX_RETIRED_PER_SESSION,
  FocusSessions,
};
