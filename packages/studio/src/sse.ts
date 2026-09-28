import type { ServerResponse } from "node:http";

/**
 * Headers every SSE response must carry.
 *
 * `Content-Type: text/event-stream` tells the browser this is an
 * `EventSource` response. `Cache-Control: no-store` prevents intermediate
 * caches from buffering events. `Connection: keep-alive` is a hint to
 * proxies; Node's HTTP server sets it automatically when the response is
 * not closed, but we declare it explicitly so reverse proxies do not
 * strip the connection.
 */
export const SSE_RESPONSE_HEADERS = Object.freeze({
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "connection": "keep-alive",
  "x-accel-buffering": "no",
} as const);

/** A single subscribed `ServerResponse` plus the bookkeeping to clean it up. */
type Subscriber = {
  readonly response: ServerResponse;
  closed: boolean;
};

/**
 * Shared pub/sub for the `/__studio/events` SSE bridge.
 *
 * Both `server.ts` (snapshot / error) and `feedback-server.ts`
 * (feedback-changed) publish through one hub per Vite dev server. The
 * hub is a process-local singleton — Phase 3 may need a per-tenant
 * variant, but Phase 2 keeps Studio's single-domain architecture.
 */
export class SseHub {
  readonly #subscribers = new Set<Subscriber>();

  /** Subscribe a response. Returns a cleanup function that detaches it. */
  subscribe(response: ServerResponse): () => void {
    const subscriber: Subscriber = { response, closed: false };
    this.#subscribers.add(subscriber);
    response.once("close", () => {
      subscriber.closed = true;
      this.#subscribers.delete(subscriber);
    });
    return () => {
      subscriber.closed = true;
      this.#subscribers.delete(subscriber);
    };
  }

  /** Number of live subscribers (used by tests + diagnostics). */
  size(): number {
    return this.#subscribers.size;
  }

  /**
   * Publish one SSE event to every live subscriber.
   *
   * Each frame is `event: <name>\ndata: <json>\n\n`. When `workspaceId`
   * is supplied (Phase 3), the payload is wrapped as
   * `{ workspaceId, ...data }` so a single global SSE stream can carry
   * events from every workspace and embedders can demultiplex by id.
   *
   * Subscribers whose socket has closed are silently dropped.
   */
  broadcast(event: string, data: unknown, workspaceId?: string): void {
    if (this.#subscribers.size === 0) return;
    const payload = workspaceId === undefined
      ? data
      : data !== null && typeof data === "object" && !Array.isArray(data)
        ? { workspaceId, ...(data as Record<string, unknown>) }
        : { workspaceId, value: data };
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const subscriber of this.#subscribers) {
      if (subscriber.closed) continue;
      try {
        subscriber.response.write(frame);
      } catch {
        subscriber.closed = true;
        this.#subscribers.delete(subscriber);
      }
    }
  }

  /** Tear down every subscriber (used on Vite server shutdown). */
  close(): void {
    for (const subscriber of this.#subscribers) {
      subscriber.closed = true;
      try { subscriber.response.end(); } catch { /* ignore */ }
    }
    this.#subscribers.clear();
  }
}