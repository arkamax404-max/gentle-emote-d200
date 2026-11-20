"use strict";

// Focus-session state machine unit tests (task T2/S1). Every assertion goes through the
// FocusSessions public methods; the fake clock drives lease/TTL boundaries deterministically.

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  FOCUS_TTL_MS,
  LEASE_MS,
  MAX_ACTIVE_SESSIONS,
  MAX_KNOWN_SESSIONS,
  MAX_RETIRED_PER_SESSION,
  FocusSessions,
} = require("../src/plugin/focus-sessions.js");

function createSessions() {
  const state = { nowMs: 1_000_000, ids: 0 };
  const focus = new FocusSessions({
    now: () => state.nowMs,
    requestId: () => `req-${(state.ids += 1)}`,
  });
  return {
    focus,
    advance: (ms) => {
      state.nowMs += ms;
    },
  };
}

test("a first frame creates a session with any valid sequence, including zero", () => {
  const { focus } = createSessions();
  assert.deepEqual(focus.acceptFrame({ session: "sess-a", stream: "t1", sequence: 0n }), {
    outcome: "fresh",
    request: null,
  });
  assert.ok(focus.press("sess-a", "t1"));
});

test("sequence comparisons are exact BigInt u64 comparisons", () => {
  const { focus } = createSessions();
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 1n }).outcome, "fresh");
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 2n }).outcome, "fresh");
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 2n }).outcome, "replay");
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 1n }).outcome, "replay");
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 18446744073709551615n }).outcome, "fresh");
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 18446744073709551615n }).outcome, "replay");
  // A brand new stream may start at the u64 maximum directly.
  assert.equal(focus.acceptFrame({ session: "s", stream: "t2", sequence: 18446744073709551615n }).outcome, "fresh");
});

test("a replay mutates nothing: pending focus survives it", () => {
  const { focus } = createSessions();
  focus.acceptFrame({ session: "s", stream: "t1", sequence: 5n });
  const id = focus.press("s", "t1");
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 4n }).outcome, "replay");
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 6n }).request, id);
});

test("a new stream takes over with any sequence and retires the previous one", () => {
  const { focus } = createSessions();
  focus.acceptFrame({ session: "s", stream: "t1", sequence: 100n });
  assert.equal(focus.acceptFrame({ session: "s", stream: "t2", sequence: 0n }).outcome, "fresh");
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 101n }).outcome, "retired");
  assert.equal(focus.heartbeat({ session: "s", stream: "t1", sequence: 102n }).outcome, "retired");
  assert.equal(focus.acceptFrame({ session: "s", stream: "t2", sequence: 0n }).outcome, "replay");
});

test("retired ids are FIFO 16 and a dropped id returns through a normal takeover", () => {
  const { focus } = createSessions();
  for (let index = 1; index <= MAX_RETIRED_PER_SESSION + 1; index += 1)
    assert.equal(focus.acceptFrame({ session: "s", stream: `t${index}`, sequence: 1n }).outcome, "fresh");
  // The 18th takeover retires t17; the overflowing FIFO drops the oldest id, t1.
  assert.equal(focus.acceptFrame({ session: "s", stream: "t18", sequence: 1n }).outcome, "fresh");
  // A dropped id is simply unknown again: it returns through a normal takeover that
  // retires the outgoing current. No special resurrection state exists.
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 2n }).outcome, "fresh");
  // The outgoing current t18 was retired normally, and t17 is still retired in the FIFO.
  assert.equal(focus.acceptFrame({ session: "s", stream: "t18", sequence: 3n }).outcome, "retired");
  assert.equal(focus.acceptFrame({ session: "s", stream: "t17", sequence: 4n }).outcome, "retired");
});

test("the 64 known-record bound evicts the least recently seen inactive record", () => {
  const { focus, advance } = createSessions();
  // Two staggered halves keep distinct lastSeen stamps while never exceeding 32 active
  // sessions at any moment.
  for (let index = 1; index <= MAX_ACTIVE_SESSIONS; index += 1) {
    focus.acceptFrame({ session: `s${index}`, stream: "t1", sequence: 1n });
    advance(1);
  }
  advance(LEASE_MS + 1); // s1..s32 expired but retained
  for (let index = MAX_ACTIVE_SESSIONS + 1; index <= 2 * MAX_ACTIVE_SESSIONS; index += 1) {
    focus.acceptFrame({ session: `s${index}`, stream: "t1", sequence: 1n });
    advance(1);
  }
  advance(LEASE_MS + 1); // s33..s64 expired: 64 known records, none active
  for (let index = MAX_ACTIVE_SESSIONS + 1; index <= 2 * MAX_ACTIVE_SESSIONS - 1; index += 1)
    focus.acceptFrame({ session: `s${index}`, stream: "t1", sequence: 2n }); // 31 active again
  // The 65th record forces the eviction of the least recently seen inactive record: s1.
  assert.equal(focus.acceptFrame({ session: "s65", stream: "t1", sequence: 1n }).outcome, "fresh");
  // s1's record is gone: its identity answers unknown and its sequence starts anew.
  assert.deepEqual(focus.close({ session: "s1", stream: "t1", sequence: 2n }), { outcome: "unknown" });
  // Retained inactive records still replay, including the second-newest one.
  assert.equal(focus.acceptFrame({ session: "s2", stream: "t1", sequence: 1n }).outcome, "replay");
  assert.equal(focus.acceptFrame({ session: "s64", stream: "t1", sequence: 1n }).outcome, "replay");
  // Every active record survived untouched.
  for (let index = MAX_ACTIVE_SESSIONS + 1; index <= 2 * MAX_ACTIVE_SESSIONS - 1; index += 1)
    assert.equal(focus.acceptFrame({ session: `s${index}`, stream: "t1", sequence: 3n }).outcome, "fresh", `s${index}`);
});

test("a 33rd heartbeat reactivation is blocked while 32 sessions are active", () => {
  const { focus, advance } = createSessions();
  for (let index = 1; index <= MAX_ACTIVE_SESSIONS; index += 1)
    focus.acceptFrame({ session: `s${index}`, stream: "t1", sequence: 1n });
  advance(LEASE_MS + 1); // all expired but retained
  for (let index = 2; index <= MAX_ACTIVE_SESSIONS + 1; index += 1) // 32 activations: s2..s33
    assert.equal(focus.acceptFrame({ session: `s${index}`, stream: "t1", sequence: 2n }).outcome, "fresh");
  // s1's record was retained; reactivating it now would create a 33rd active session.
  assert.deepEqual(focus.heartbeat({ session: "s1", stream: "t1", sequence: 2n }), { outcome: "full" });
  assert.deepEqual(focus.heartbeat({ session: "s1", stream: "t1", sequence: 2n }), { outcome: "full" });
  // The rejected packet left the record unchanged: an older sequence still replays.
  assert.equal(focus.heartbeat({ session: "s1", stream: "t1", sequence: 1n }).outcome, "replay");
});

test("a closed record frees its active slot immediately and keeps replay protection", () => {
  const { focus } = createSessions();
  for (let index = 1; index <= MAX_ACTIVE_SESSIONS; index += 1)
    focus.acceptFrame({ session: `s${index}`, stream: "t1", sequence: 1n });
  assert.deepEqual(focus.acceptFrame({ session: "s33", stream: "t1", sequence: 1n }), { outcome: "full" });
  assert.equal(focus.close({ session: "s7", stream: "t1", sequence: 2n }).outcome, "closed");
  // The replay record is retained, but the active slot is reusable at once, without
  // waiting for any lease.
  assert.equal(focus.heartbeat({ session: "s7", stream: "t1", sequence: 3n }).outcome, "closed");
  assert.equal(focus.acceptFrame({ session: "s33", stream: "t1", sequence: 1n }).outcome, "fresh");
});

test("close marks the stream closed; it cannot revive, but a new stream can take over", () => {
  const { focus } = createSessions();
  focus.acceptFrame({ session: "s", stream: "t1", sequence: 1n });
  assert.equal(focus.close({ session: "s", stream: "t1", sequence: 2n }).outcome, "closed");
  assert.equal(focus.heartbeat({ session: "s", stream: "t1", sequence: 3n }).outcome, "closed");
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 4n }).outcome, "closed");
  assert.equal(focus.acceptFrame({ session: "s", stream: "t2", sequence: 0n }).outcome, "fresh");
  // The closed id retires into the FIFO when the takeover happens: it is just retired now.
  assert.equal(focus.heartbeat({ session: "s", stream: "t1", sequence: 5n }).outcome, "retired");
});

test("unknown lifecycle targets never create state", () => {
  const { focus } = createSessions();
  assert.equal(focus.heartbeat({ session: "ghost", stream: "t1", sequence: 2n }).outcome, "unknown");
  assert.equal(focus.close({ session: "ghost", stream: "t1", sequence: 2n }).outcome, "unknown");
  focus.acceptFrame({ session: "s", stream: "t1", sequence: 1n });
  assert.equal(focus.heartbeat({ session: "s", stream: "other", sequence: 2n }).outcome, "unknown");
  assert.equal(focus.press("ghost", "t1"), null);
  // A lifecycle call must not have pre-created anything: sequence 0 still creates fresh.
  assert.equal(focus.acceptFrame({ session: "ghost", stream: "t1", sequence: 0n }).outcome, "fresh");
});

test("heartbeat refreshes the lease and reactivates an expired not-closed stream", () => {
  const { focus, advance } = createSessions();
  focus.acceptFrame({ session: "s", stream: "t1", sequence: 1n });
  advance(LEASE_MS - 1);
  assert.ok(focus.press("s", "t1"));
  advance(1); // exactly at the lease boundary: expired
  assert.equal(focus.press("s", "t1"), null);
  assert.equal(focus.heartbeat({ session: "s", stream: "t1", sequence: 2n }).outcome, "fresh");
  assert.ok(focus.press("s", "t1"));
  assert.equal(focus.heartbeat({ session: "s", stream: "t1", sequence: 2n }).outcome, "replay");
});

test("a fresh frame reactivates an expired session", () => {
  const { focus, advance } = createSessions();
  focus.acceptFrame({ session: "s", stream: "t1", sequence: 1n });
  advance(LEASE_MS + 1);
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 2n }).outcome, "fresh");
  assert.ok(focus.press("s", "t1"));
});

test("focus requests are replaced by each press and cleared by a matching ack", () => {
  const { focus } = createSessions();
  focus.acceptFrame({ session: "s", stream: "t1", sequence: 1n });
  const first = focus.press("s", "t1");
  const second = focus.press("s", "t1");
  assert.notEqual(first, second);
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 2n }).request, second);
  assert.equal(focus.ack({ session: "s", id: first }), false);
  assert.equal(focus.ack({ session: "s", id: "bogus" }), false);
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 3n }).request, second);
  assert.equal(focus.ack({ session: "s", id: second }), true);
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 4n }).request, null);
});

test("focus TTL is 15s from the click and redelivery does not extend it", () => {
  const { focus, advance } = createSessions();
  focus.acceptFrame({ session: "s", stream: "t1", sequence: 1n });
  const id = focus.press("s", "t1");
  advance(FOCUS_TTL_MS - 1);
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 2n }).request, id);
  advance(1); // TTL boundary
  assert.equal(focus.acceptFrame({ session: "s", stream: "t1", sequence: 3n }).request, null);
  // The session itself is still inside its 30s lease, so a new press works.
  assert.ok(focus.press("s", "t1"));
});

test("takeover, close, expiry and stop clear a pending focus request", () => {
  const { focus, advance } = createSessions();
  focus.acceptFrame({ session: "s1", stream: "t1", sequence: 1n });
  focus.press("s1", "t1");
  assert.equal(focus.acceptFrame({ session: "s1", stream: "t2", sequence: 1n }).request, null);
  assert.equal(focus.acceptFrame({ session: "s1", stream: "t2", sequence: 2n }).request, null);

  focus.acceptFrame({ session: "s2", stream: "t1", sequence: 1n });
  focus.press("s2", "t1");
  focus.close({ session: "s2", stream: "t1", sequence: 2n });
  assert.equal(focus.press("s2", "t1"), null);

  focus.acceptFrame({ session: "s3", stream: "t1", sequence: 1n });
  focus.press("s3", "t1");
  advance(LEASE_MS + 1);
  assert.equal(focus.heartbeat({ session: "s3", stream: "t1", sequence: 2n }).request, null);

  focus.acceptFrame({ session: "s4", stream: "t1", sequence: 1n });
  focus.press("s4", "t1");
  focus.stop();
  assert.equal(focus.press("s4", "t1"), null);
  assert.equal(focus.ack({ session: "s4", id: "whatever" }), false);
});

test("press is a no-op for retired, closed or noncurrent streams", () => {
  const { focus } = createSessions();
  focus.acceptFrame({ session: "s", stream: "t1", sequence: 1n });
  focus.acceptFrame({ session: "s", stream: "t2", sequence: 1n }); // t1 retired
  assert.equal(focus.press("s", "t1"), null);
  focus.acceptFrame({ session: "s", stream: "t3", sequence: 1n }); // t2 retired
  focus.close({ session: "s", stream: "t3", sequence: 2n });
  assert.equal(focus.press("s", "t3"), null);
  assert.equal(focus.press("s", "unknown-stream"), null);
});

test("session capacity: 32 active sessions max, graceful full, expired records make room", () => {
  const { focus, advance } = createSessions();
  for (let index = 1; index <= MAX_ACTIVE_SESSIONS; index += 1)
    focus.acceptFrame({ session: `s${index}`, stream: "t1", sequence: 1n });
  assert.deepEqual(focus.acceptFrame({ session: "s33", stream: "t1", sequence: 1n }), { outcome: "full" });
  // Live sessions are never evicted: the first one still carries fresh traffic.
  assert.equal(focus.acceptFrame({ session: "s1", stream: "t1", sequence: 2n }).outcome, "fresh");
  assert.ok(focus.press("s1", "t1"));
  advance(LEASE_MS + 1); // every session expired
  assert.equal(focus.acceptFrame({ session: "s33", stream: "t1", sequence: 1n }).outcome, "fresh");
});

test("a mix of live and expired sessions only activates the eligible ones", () => {
  const { focus, advance } = createSessions();
  for (let index = 1; index < MAX_ACTIVE_SESSIONS; index += 1)
    focus.acceptFrame({ session: `live${index}`, stream: "t1", sequence: 1n });
  focus.acceptFrame({ session: "stale", stream: "t1", sequence: 1n });
  advance(LEASE_MS + 1);
  for (let index = 1; index < MAX_ACTIVE_SESSIONS; index += 1)
    focus.acceptFrame({ session: `live${index}`, stream: "t1", sequence: 2n }); // all live again
  assert.equal(focus.acceptFrame({ session: "fresh-new", stream: "t1", sequence: 1n }).outcome, "fresh");
  assert.deepEqual(focus.acceptFrame({ session: "one-more", stream: "t1", sequence: 1n }), { outcome: "full" });
});
