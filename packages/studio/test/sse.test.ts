import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import test from "node:test";
import { SseHub, SSE_RESPONSE_HEADERS } from "../src/sse.js";

/**
 * Minimal stub of `ServerResponse` that captures what the hub writes.
 * The real Node `ServerResponse` is too heavy to instantiate in unit tests;
 * we only need `write`, `end` and the `close` event. The stub exposes
 * `response` (the ServerResponse-shaped object the hub sees) plus the
 * `emitted` array and `closed` flag for assertions.
 */
type StubResponse = {
  readonly response: ServerResponse;
  readonly emitted: string[];
  closed: boolean;
};

function captureResponse(): StubResponse {
  const emitter = new EventEmitter();
  const emitted: string[] = [];
  const stub: StubResponse = {
    emitted,
    closed: false,
    response: undefined as unknown as ServerResponse,
  };
  const proxy = {
    write(chunk: string): boolean {
      emitted.push(chunk);
      return true;
    },
    end(): void {
      stub.closed = true;
      emitter.emit("close");
    },
  };
  (proxy as unknown as { on: typeof EventEmitter.prototype.on }).on = emitter.on.bind(emitter);
  (proxy as unknown as { once: typeof EventEmitter.prototype.once }).once = emitter.once.bind(emitter);
  (proxy as unknown as { emit: typeof EventEmitter.prototype.emit }).emit = emitter.emit.bind(emitter);
  (stub as unknown as { response: unknown }).response = proxy as unknown as ServerResponse;
  return stub;
}

test("SSE response headers carry the standard set", () => {
  assert.equal(SSE_RESPONSE_HEADERS["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(SSE_RESPONSE_HEADERS["cache-control"], "no-store");
  assert.equal(SSE_RESPONSE_HEADERS["connection"], "keep-alive");
  assert.equal(SSE_RESPONSE_HEADERS["x-accel-buffering"], "no");
});

test("SseHub broadcasts to every live subscriber", () => {
  const hub = new SseHub();
  const a = captureResponse();
  const b = captureResponse();
  hub.subscribe(a.response);
  hub.subscribe(b.response);
  hub.broadcast("studio:snapshot", { revision: 1 });
  assert.equal(a.emitted.length, 1);
  assert.equal(b.emitted.length, 1);
  assert.equal(a.emitted[0], 'event: studio:snapshot\ndata: {"revision":1}\n\n');
  assert.equal(b.emitted[0], 'event: studio:snapshot\ndata: {"revision":1}\n\n');
});

test("SseHub drops subscribers whose response has closed", () => {
  const hub = new SseHub();
  const stub = captureResponse();
  hub.subscribe(stub.response);
  assert.equal(hub.size(), 1);
  // Simulate the underlying socket closing.
  stub.response.end();
  assert.equal(hub.size(), 0, "the 'close' event detaches the subscriber");
  hub.broadcast("studio:error", { message: "ignored" });
  assert.equal(stub.emitted.length, 0);
});

test("SseHub.subscribe returns a cleanup function", () => {
  const hub = new SseHub();
  const stub = captureResponse();
  const unsubscribe = hub.subscribe(stub.response);
  assert.equal(hub.size(), 1);
  unsubscribe();
  assert.equal(hub.size(), 0);
  hub.broadcast("studio:snapshot", { revision: 2 });
  assert.equal(stub.emitted.length, 0);
});

test("SseHub.close tears down every subscriber", () => {
  const hub = new SseHub();
  const a = captureResponse();
  const b = captureResponse();
  hub.subscribe(a.response);
  hub.subscribe(b.response);
  hub.close();
  assert.equal(hub.size(), 0);
  assert.equal(a.closed, true);
  assert.equal(b.closed, true);
});

test("SseHub.broadcast is a no-op when no one is listening", () => {
  const hub = new SseHub();
  // Should not throw or warn.
  hub.broadcast("studio:snapshot", { revision: 0 });
  assert.equal(hub.size(), 0);
});

test("SseHub.broadcast skips subscribers whose response has emitted close", () => {
  const hub = new SseHub();
  const live = captureResponse();
  const closed = captureResponse();
  hub.subscribe(live.response);
  hub.subscribe(closed.response);
  // Trigger the real 'close' event so the subscriber detaches itself.
  closed.response.end();
  assert.equal(hub.size(), 1, "the 'close' event pruned the closed subscriber from the set");
  hub.broadcast("studio:feedback-changed", {});
  assert.equal(live.emitted.length, 1);
  assert.equal(closed.emitted.length, 0, "broadcast never reaches a closed subscriber");
});