import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/** Studio writes belong to the local page serving this Studio session. */
export function allowsStudioMutation(headers: IncomingHttpHeaders): boolean {
  const host = headers.host;
  if (host === undefined) return false;
  let target: URL;
  try { target = new URL(`http://${host}`); } catch { return false; }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) || target.host !== host.toLowerCase()) return false;

  const origin = headers.origin;
  if (origin !== undefined) {
    let source: URL;
    try { source = new URL(origin); } catch { return false; }
    if (source.origin !== origin || source.origin !== target.origin) return false;
  }

  const site = headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

/**
 * Phase 2 — Bearer-token variant of `allowsStudioMutation`.
 *
 * Accepts a write when **either** the loopback / same-origin check passes
 * (so the existing local Studio UI keeps working unchanged) **or** the
 * caller presents a configured `Authorization: Bearer <token>` header.
 *
 * The token check is constant-time to avoid leaking the prefix byte-by-byte.
 *
 * `configuredToken === undefined` (no `HYPIT_STUDIO_TOKEN` env var) means
 * the server is in Phase 1 mode: token-asserted writes are not accepted
 * from anywhere; only loopback works.
 */
export function allowsStudioMutationWithToken(
  headers: IncomingHttpHeaders,
  configuredToken: string | undefined,
): boolean {
  if (allowsStudioMutation(headers)) return true;
  if (configuredToken === undefined || configuredToken === "") return false;
  const auth = headers.authorization;
  if (typeof auth !== "string") return false;
  const expected = `Bearer ${configuredToken}`;
  // Constant-time compare requires equal-length buffers.
  const a = Buffer.from(auth);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
