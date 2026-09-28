import type { IncomingHttpHeaders } from "node:http";

/**
 * How Studio answers requests that originate from a third-party page.
 *
 * Phase 1 only relaxes the network reachability of the read-only preview
 * surface; the write endpoints remain guarded by `allowsStudioMutation`
 * (`mutation-origin.ts`). Public origins are configured per-deployment —
 * unset means the Studio behaves exactly like it does today (localhost only).
 */
export type PublicOrigins =
  | { readonly mode: "none" }
  | { readonly mode: "open" }
  | { readonly mode: "list"; readonly origins: readonly string[] };

/** Parse the `HYPIT_STUDIO_PUBLIC_ORIGINS` environment variable. */
export function parsePublicOrigins(value: string | undefined): PublicOrigins {
  if (value === undefined) return { mode: "none" };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { mode: "none" };
  if (trimmed === "*") return { mode: "open" };
  const origins = trimmed.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return origins.length === 0 ? { mode: "none" } : { mode: "list", origins };
}

/**
 * Resolve which origin (if any) the response should advertise.
 *
 * Returns `"*"` for open mode, the request `Origin` when it is whitelisted,
 * or `undefined` when the request must not receive CORS headers at all
 * (no config / non-matching whitelist).
 */
export function allowedOriginHeader(requestOrigin: string | undefined, config: PublicOrigins): string | undefined {
  if (config.mode === "none") return undefined;
  if (config.mode === "open") return "*";
  if (requestOrigin === undefined) return undefined;
  return config.origins.includes(requestOrigin) ? requestOrigin : undefined;
}

/**
 * CORS response headers for a `/__studio/*` GET/HEAD request.
 *
 * Returns `{}` when no CORS advertisement should be sent. The caller is
 * expected to merge these into whatever headers the rest of the handler
 * sets — we never override `cache-control` or `content-type` here.
 */
export function corsHeaders(requestOrigin: string | undefined, config: PublicOrigins): Readonly<Record<string, string>> {
  const allow = allowedOriginHeader(requestOrigin, config);
  if (allow === undefined) return {};
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "content-type, range",
    "access-control-max-age": "86400",
    "vary": "Origin",
  };
}

/**
 * `Content-Security-Policy: frame-ancestors` directive for `visual.html`.
 *
 * The middleware only ever returns a value when public origins are
 * configured — when `mode` is `"none"`, the existing browser default
 * (any page may embed) is preserved, which matches the localhost Studio
 * UI's own behaviour.
 */
export function frameAncestors(config: PublicOrigins): string | undefined {
  if (config.mode === "none") return undefined;
  if (config.mode === "open") return "frame-ancestors *";
  return `frame-ancestors ${config.origins.join(" ")}`;
}

/**
 * Vite `connect` middleware that decorates `/__studio/*` responses with the
 * CORS + `frame-ancestors` headers Phase 1 exposes to third-party pages.
 *
 * The middleware scopes itself to `/__studio/*` and short-circuits only
 * for `OPTIONS` preflight. Every other request is forwarded to the next
 * handler so the existing Studio plugin keeps full control over response
 * bodies and its loopback mutation gate (`allowsStudioMutation`).
 */
export function studioCorsMiddleware(
  config: PublicOrigins,
): (request: { readonly url?: string; readonly method?: string; readonly headers: IncomingHttpHeaders },
    response: { setHeader(name: string, value: string): void; statusCode?: number; end(chunk?: unknown): void },
    next: (error?: unknown) => void) => void {
  return (request, response, next) => {
    const url = new URL(request.url ?? "/", "http://studio.hypit.local");
    if (!url.pathname.startsWith("/__studio/")) {
      next();
      return;
    }
    const headers = corsHeaders(request.headers.origin, config);
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.end();
      return;
    }
    next();
  };
}