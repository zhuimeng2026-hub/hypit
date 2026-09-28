# TODO — Studio network embedding

Status: **All three phases shipped** (read-only preview, token-authenticated
writes + SSE bridge, multi-tenant workspace pool). The Studio can now serve
many projects from one process behind one reverse proxy.

| Phase | Scope | Status |
|---|---|---|
| 1 | Bind to a routable address; add CORS + `frame-ancestors` so third-party pages can embed the preview. Read-only. | **Shipped** |
| 2 | Replace the loopback mutation gate with Bearer-token auth; add an SSE bridge for snapshot/error/feedback events so external clients don't have to poll. | **Shipped** |
| 3 | Replace the singleton `StudioDomain` / `StudioBuildLibrary` with a per-workspace map keyed by workspace identity, so one Studio process can serve many projects. | **Shipped** |

| Path | Purpose |
|---|---|
| `GET /__studio/visual.html` | Materialized HyperFrames HTML with the Studio frame driver + audio shim |
| `GET /__studio/session` | Full `StudioSnapshot` (revision, source files, tracks, semantic timeline, preview srcdoc, provenance) |
| `GET /__studio/document` | Compiled `HyperframesDocument` JSON |
| `GET /__studio/material/<id>` | Resource bytes (Range-supported) |
| `GET /__studio/storyboard/<id>` | PNG storyboard atlas (custom `x-hypit-storyboard-*` headers) |
| `GET /__studio/library` | Runtime activity + Result repository views |
| `GET /__studio/locales` | Language packs |
| `GET /__studio/surface-preview` | Package-declared surface previews |
| `GET /__studio/artifact` | Build result artifact bytes |
| `GET /__studio/feedback` | Read-only access to `FEEDBACK.json` |

This API has always been reachable; it just wasn't reachable from anywhere
except the Studio UI on `localhost`. The only barrier was a missing
`host:` on Vite's `server.listen()` and the absence of CORS / `frame-ancestors`
headers on responses. The write endpoints
(`PUT /__studio/source`, `PUT /__studio/artifact-name`,
`POST /__studio/mutation`, `POST /__studio/feedback`) are guarded by
`allowsStudioMutation` (`packages/studio/src/mutation-origin.ts:1-20`),
which returns 403 for non-loopback origins. Phase 1 leaves that gate
untouched.

`packages/video-cli/src/snapshot.ts:60-67, 109-152` already consumes
`GET /__studio/document` and `GET /__studio/material/<resource>` over plain
HTTP, confirming that these endpoints are a stable external contract.

## Phases

| Phase | Scope | Status |
|---|---|---|
| 1 | Bind to a routable address; add CORS + `frame-ancestors` so third-party pages can embed the preview. Read-only. | **Shipped** |
| 2 | Replace the loopback mutation gate with Bearer-token auth; add an SSE bridge for snapshot/error/feedback events so external clients don't have to poll. | **Shipped** |
| 3 | Replace the singleton `StudioDomain` / `StudioBuildLibrary` with a per-session map keyed by workspace identity, so one Studio process can serve many projects. | **Shipped** |

## Phase 1 — what changed

### New env vars

```
HYPIT_STUDIO_HOST=0.0.0.0          # bind address; default = unset (localhost only)
HYPIT_STUDIO_PUBLIC_ORIGINS=...    # comma-separated origin whitelist or "*";
                                   # default unset = no cross-origin access
HYPIT_STUDIO_TOKEN=...             # Bearer token authorising cross-origin writes;
                                   # default unset = auto-generated + printed once
```

`HYPIT_STUDIO_HOST` and `HYPIT_STUDIO_PUBLIC_ORIGINS` are Phase 1 (unchanged):

- `HYPIT_STUDIO_HOST` unset → Vite binds to localhost (default).
- `HYPIT_STUDIO_PUBLIC_ORIGINS` unset → no CORS, no `frame-ancestors`.
  Browsers block third-party embeds and XHR.
- `"*"` → `Access-Control-Allow-Origin: *` on all `/__studio/*` GETs, and
  `Content-Security-Policy: frame-ancestors *` on `visual.html`. Open.
- `"https://a.com,https://b.com"` → CORS echoes the matching origin
  only; `frame-ancestors` is set to the same list. Strict whitelist.

`HYPIT_STUDIO_TOKEN` is Phase 2:

- unset → a 32-character URL-safe random token is generated at startup and
  printed in the banner. It is **not persisted**; a Studio restart mints
  a new one.
- set → the configured value is used verbatim. Operators who want a stable
  token across restarts should pin it.

The token authorises cross-origin writes (`PUT /__studio/source`,
`PUT /__studio/artifact-name`, `POST /__studio/mutation`,
`POST /__studio/feedback`) when the request carries
`Authorization: Bearer <token>`. The loopback / same-origin check still
passes the local Studio UI without a token — the two checks are
independent OR-ed in `allowsStudioMutationWithToken`
(`packages/studio/src/mutation-origin.ts:31-49`), so local dev never
needs the token.

The startup banner prints the resolved values, so operators can confirm
the configuration at a glance.

### File changes

| File | Change |
|---|---|
| `packages/studio/src/cors.ts` *(new)* | Pure module: `parsePublicOrigins`, `corsHeaders`, `frameAncestors`, `studioCorsMiddleware` |
| `packages/studio/src/sse.ts` *(new, Phase 2)* | `SseHub` pub/sub + `SSE_RESPONSE_HEADERS`; closes subscribers on `'close'` events; Phase 3 adds optional `workspaceId` stamping |
| `packages/studio/src/workspace-registry.ts` *(new, Phase 3)* | `WorkspaceSession` (per-workspace compile state + handlers) + `WorkspaceRegistry` (lazy map + LRU eviction) + `workspaceIdFor()` |
| `packages/studio/test/cors.test.ts` *(new)* | 9 cases covering config parsing, header generation, middleware ordering, OPTIONS preflight |
| `packages/studio/test/sse.test.ts` *(new, Phase 2)* | 7 cases: header shape, broadcast fan-out, close-time pruning, unsubscribe, hub shutdown |
| `packages/studio/test/workspace-registry.test.ts` *(new, Phase 3)* | 8 cases: id derivation, lazy creation, same-id dedupe, LRU eviction, concurrent-acquire dedupe, `close()` teardown, `lastUsed` bump |
| `packages/studio/src/server.ts` | `StudioPluginOptions.corsConfig` (default `{ mode: "none" }`) — Phase 1. Phase 2 adds `authToken` + `sseHub`. Phase 3 makes it a thin dispatcher; per-workspace state lives in `WorkspaceSession`. New options: `workspaces`, `defaultWorkspaceId`, `loader`. |
| `packages/studio/src/feedback-server.ts` | `studioFeedbackPlugin` accepts optional `corsConfig` (Phase 1) + `authToken` + `sseHub` (Phase 2). Phase 3 makes feedback per-workspace: lazy `FeedbackStore` + `FEEDBACK.json` watcher per `workspaceId`. |
| `packages/studio/src/mutation-origin.ts` | Adds `allowsStudioMutationWithToken` alongside the existing `allowsStudioMutation`. The loopback check is the first path; the constant-time Bearer-token comparison is the second. Either passing the request is enough. |
| `packages/studio/start.ts` | Reads `HYPIT_STUDIO_HOST` + `HYPIT_STUDIO_PUBLIC_ORIGINS` (Phase 1) and `HYPIT_STUDIO_TOKEN` (Phase 2). Phase 3 adds `HYPIT_STUDIO_WORKSPACES` / `HYPIT_STUDIO_DEFAULT_WORKSPACE` / `HYPIT_STUDIO_MAX_WORKSPACES`. Builds `Map<workspaceId, WorkspaceSpec>`, prewarms each through `WorkspaceRegistry.acquire`, threads the workspace map + loader to both plugins. Help text reflects every env var. |
| `packages/studio/test/mutation-origin.test.ts` | Three new cases for `allowsStudioMutationWithToken` (loopback path, valid token, invalid token); existing feedback-test updated for the new plugin signature |

### Why this is safe

A third-party `<iframe sandbox="allow-scripts allow-same-origin"
src="https://studio.example.com/__studio/visual.html">` loads the same
`visual.html` the Studio UI already uses via `<iframe srcdoc=...>`. The
iframe's effective origin is the studio host, which means:

- The iframe can fetch `/__studio/material/<id>` (same origin).
- The parent (third-party page) cannot read the iframe's DOM.
- The iframe cannot read the parent's DOM.
- The iframe cannot navigate the parent.
- No cookies / credentials / user state are sent on these reads.

Phase 1 only relaxes network reachability, not the trust boundary. There
is no new attack surface compared to the localhost Studio UI.

## Embedder recipes

### 1. Embed `<iframe>` (simplest)

The studio serves a fully self-contained HTML document at
`/__studio/visual.html`. Drop this into any third-party page:

```html
<iframe
  src="https://studio.example.com/__studio/visual.html"
  sandbox="allow-scripts allow-same-origin"
  allow="autoplay"
  width="1280" height="720"
  style="border:0"
></iframe>
```

Notes:
- `sandbox="allow-scripts allow-same-origin"` is required: the runtime
  shim (`packages/studio/src/preview/runtime-shim.ts`) needs to fetch
  `/__studio/material/<id>` from the same origin. Without
  `allow-same-origin` the iframe origin becomes `null` and cross-origin
  blocks resource loading.
- `allow="autoplay"` lets the `<audio class="hypit-studio-audio">` tags
  play. Without it the user has to click first.
- Audio plays after a user gesture regardless (browser autoplay policy).

### 2. Poll `/__studio/session` (custom UI)

For non-iframe embedding, fetch the JSON snapshot and render your own UI:

```js
async function pollStudio() {
  const r = await fetch("https://studio.example.com/__studio/session", {
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`Studio ${r.status}`);
  const snapshot = await r.json();
  // snapshot.preview is the same srcdoc Studio injects into its iframe.
  // Material URLs are /__studio/material/<id> on the studio host.
  return snapshot;
}
setInterval(pollStudio, 2000);
```

The `preview` field carries the same HTML the `<iframe>` endpoint serves.
Material references resolve against the studio host. Reuse
`/__studio/material/<id>` directly from your page if you do not need the
studio frame driver.

### 3. Fetch `/__studio/material/<id>` directly

Resource bytes are served with `Accept-Ranges: bytes` support. Use them
in your own `<video>` / `<audio>` / `<img>` tags pointed at the studio
host. The preview's `media` array tells you which `<video>` belongs to
which `<div class="hypit-visual-present">`.

### 4. Subscribe to `/__studio/events` (Phase 2)

Every `studio:snapshot`, `studio:error` and `studio:feedback-changed`
event is broadcast over Server-Sent Events:

```js
const source = new EventSource("https://studio.example.com/__studio/events");
source.addEventListener("studio:snapshot", (e) => {
  const snapshot = JSON.parse(e.data);
  // Same payload as GET /__studio/session.
  renderPreview(snapshot);
});
source.addEventListener("studio:error", (e) => {
  const failure = JSON.parse(e.data);
  showError(failure.error);
});
source.addEventListener("studio:feedback-changed", () => {
  // Comments changed; refetch GET /__studio/feedback.
});
```

Notes:
- The stream is open-ended; the server keeps the connection until the
  page closes. A reverse proxy in front must NOT buffer it
  (`X-Accel-Buffering: no` is already on the response headers).
- The same event names as Vite's HMR WebSocket (`server.ts:192, 202,
  459, 465`) flow through this stream, so a custom UI and the local
  Studio UI stay in lock-step.

### 5. Issue a cross-origin write (Phase 2)

Once `HYPIT_STUDIO_TOKEN` is configured (either explicitly or accepted
from the startup banner), a third-party page can drive Studio edits
directly:

```js
async function studioFetch(path, body) {
  const r = await fetch(`https://studio.example.com${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${STUDIO_TOKEN}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Studio ${r.status}: ${await r.text()}`);
  return r.json();
}

// Apply a timeline gesture:
const { revision } = await studioFetch("/__studio/mutation", {
  type: "timeline.adjust",
  revision: snapshot.revision,
  entityId: "clip-7",
  gesture: "move",
  target: { kind: "window", startFrame: 240, endFrameExclusive: 360 },
});
```

The token must be served to the page over a secure channel
(back-end session, signed cookie, mTLS, etc.) — never embed it in
client JS that ships to untrusted users.

## Reverse proxy examples

Studio binds plaintext HTTP only. TLS termination belongs to a proxy.
The proxy should NOT add its own CORS headers — let Studio's
middleware do that — but it must forward the `Origin` and (for
material) `Range` headers intact.

### nginx

```nginx
server {
  listen 443 ssl http2;
  server_name studio.example.com;

  ssl_certificate     /etc/letsencrypt/live/studio.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/studio.example.com/privkey.pem;

  # Studio runs plaintext on :5179.
  location / {
    proxy_pass http://127.0.0.1:5179;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Forward the Origin header unchanged so Studio's CORS middleware can
    # match it against HYPIT_STUDIO_PUBLIC_ORIGINS.
    proxy_pass_header Origin;
    # material/ supports Range — let nginx proxy it transparently.
    proxy_set_header Range $http_range;
    proxy_no_cache 1;
    add_header Cache-Control "no-store";
  }
}
```

### Caddy

```caddyfile
studio.example.com {
  reverse_proxy 127.0.0.1:5179 {
    header_up Host {host}
    header_up X-Real-IP {remote_host}
    # Caddy passes Origin through by default — do NOT strip it.
  }
}
```

## Operator runbook

### Local dev (unchanged)

```
pnpm studio --run runs/main.svrun
# → http://localhost:5179
```

### Single-tenant network embedding

```
HYPIT_STUDIO_HOST=0.0.0.0 \
HYPIT_STUDIO_PUBLIC_ORIGINS=https://myapp.test,https://staging.myapp.test \
pnpm studio --run runs/main.svrun --port 5179

# Smoke test the CORS / frame-ancestors policy:
curl -sI -H "Origin: https://myapp.test" \
  http://localhost:5179/__studio/visual.html | grep -iE 'access-control|content-security-policy'
# Expect:
#   access-control-allow-origin: https://myapp.test
#   access-control-max-age: 86400
#   vary: Origin
#   content-security-policy: frame-ancestors https://myapp.test https://staging.myapp.test

# Non-whitelisted origin is silently ignored:
curl -sI -H "Origin: https://other.test" \
  http://localhost:5179/__studio/visual.html | grep -i access-control-allow-origin
# Expect: no output.

# OPTIONS preflight:
curl -sI -X OPTIONS -H "Origin: https://myapp.test" \
  http://localhost:5179/__studio/visual.html
# Expect: HTTP/1.1 204 No Content, with the same CORS headers.

# Writes still rejected (loopback gate unchanged):
curl -sI -X PUT -H "Origin: https://myapp.test" \
  http://localhost:5179/__studio/source
# Expect: HTTP/1.1 403 Forbidden.
```

### Verification

```
pnpm test                                          # full default suite
pnpm test -- packages/studio/test/cors.test.ts
pnpm test -- packages/studio/test/sse.test.ts
pnpm test -- packages/studio/test/mutation-origin.test.ts
pnpm test -- packages/studio/test/workspace-registry.test.ts
```

### Phase 2 smoke (manual)

```
HYPIT_STUDIO_HOST=0.0.0.0 \
HYPIT_STUDIO_PUBLIC_ORIGINS=https://myapp.test \
pnpm studio --run runs/main.svrun --port 5179

# Startup banner shows the resolved values, including the auto-generated
# Write token (or the one from HYPIT_STUDIO_TOKEN):
#
#   Bind host          0.0.0.0
#   Public origins     https://myapp.test
#   Write token        9b3X...yq  (auto-generated for this session)
#   Embed SSE          GET /__studio/events  (snapshot / error / feedback-changed)

# Token-gated write is accepted from any origin:
TOKEN=9b3X...yq
curl -s -X PUT -H "Origin: https://myapp.test" \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:5179/__studio/source \
  --data '{"text":"<svml/>","revision":1}'
# Expect: HTTP/1.1 202 Accepted

# Wrong / missing token still gets 403:
curl -s -o /dev/null -w "%{http_code}\n" -X PUT -H "Origin: https://myapp.test" \
  http://localhost:5179/__studio/source --data '{"text":"x","revision":1}'
# Expect: 403

# SSE bridge is reachable and starts with the keep-alive comment:
curl -sN -H "Origin: https://myapp.test" http://localhost:5179/__studio/events | head -5
# Expect:
#   : ok
#   (then event frames when something publishes)
```

## Phase 3 — what changed

### URL convention (workspace selector)

Every workspace-bound endpoint now carries the workspace id in the path
prefix. The global SSE stream is the only workspace-agnostic endpoint.

| Before (Phases 1/2) | After (Phase 3) |
|---|---|
| `GET /__studio/session` | `GET /__studio/<workspaceId>/session` |
| `POST /__studio/mutation` | `POST /__studio/<workspaceId>/mutation` |
| `GET /__studio/visual.html` | `GET /__studio/<workspaceId>/visual.html` |
| `GET /__studio/material/<id>` | `GET /__studio/<workspaceId>/material/<id>` |
| `GET /__studio/feedback` | `GET /__studio/<workspaceId>/feedback` |
| `GET /__studio/events` | `GET /__studio/events` *(unchanged)* |

`workspaceId` = `base64url(absoluteWorkspaceRootPath)`. Same workspace
root → same id (deterministic, URL-safe, no `:` / `/` / padding).

### New env vars

```
HYPIT_STUDIO_WORKSPACES=<rootA>::<runA>,<rootB>::<runB>  # pre-register workspaces
HYPIT_STUDIO_DEFAULT_WORKSPACE=<root>                   # bare /__studio/<rest> target
HYPIT_STUDIO_MAX_WORKSPACES=8                          # LRU cap (default 8)
```

`HYPIT_STUDIO_WORKSPACES` replaces `--run` for multi-tenant mode.
The list is comma-separated; each entry is `<workspaceRoot>::<runPath>`,
both resolved relative to the current directory. When unset, the legacy
`--run` + `--workspace` flags still produce a one-element list (single
tenant back-compat).

`HYPIT_STUDIO_DEFAULT_WORKSPACE` selects which registered workspace a
bare `/__studio/<rest>` request lands on. The first registered workspace
is the default when this is unset.

`HYPIT_STUDIO_MAX_WORKSPACES` caps the LRU pool. When a new workspace
arrives that would push the pool past this number, the least-recently-
used session's build library and file watchers are closed and the
session is dropped from the map.

### Per-workspace SSE demultiplexing

`/__studio/events` is the single global SSE stream; every event
payload gains a `workspaceId` field so embedders can route frames:

```js
source.addEventListener("studio:snapshot", (e) => {
  const { workspaceId, ...snapshot } = JSON.parse(e.data);
  if (workspaceId !== myWorkspace) return;
  renderPreview(snapshot);
});
```

The hub itself stays a single `SseHub` instance
(`packages/studio/src/sse.ts`). `broadcast(event, data, workspaceId)`
stamps the id; no fan-out restructuring was needed.

### File changes

| File | Change |
|---|---|
| `packages/studio/src/workspace-registry.ts` *(new)* | `WorkspaceSession` (per-workspace compile state + handlers) + `WorkspaceRegistry` (lazy map + LRU eviction). Bulk of the Phase-1/2 `studioPlugin` body moved here with `let foo` → `this.#foo`. |
| `packages/studio/test/workspace-registry.test.ts` *(new)* | 8 cases: id derivation, lazy creation, same-id dedupe, LRU eviction, concurrent-acquire dedupe, `close()` teardown, `lastUsed` bump |
| `packages/studio/src/server.ts` | Now a thin dispatcher. New `StudioPluginOptions.workspaces` / `defaultWorkspaceId` / `loader`. URL parser recognises `/__studio/<id>/<rest>` and bare-path fallback. The whole per-workspace request handler moved into `WorkspaceSession.handleRequest`. |
| `packages/studio/src/feedback-server.ts` | Per-workspace `FeedbackStore` + watcher, lazy-created on first request. URL prefix resolves workspaceId the same way as `studioPlugin`. The watcher broadcasts `studio:feedback-changed` through the SSE hub (events now carry `workspaceId`). |
| `packages/studio/src/sse.ts` | `SseHub.broadcast(event, data, workspaceId?)` stamps the payload with `{ workspaceId, ...data }` when `workspaceId` is supplied. |
| `packages/studio/start.ts` | Reads `HYPIT_STUDIO_WORKSPACES` / `HYPIT_STUDIO_DEFAULT_WORKSPACE` / `HYPIT_STUDIO_MAX_WORKSPACES`; builds `Map<workspaceId, WorkspaceSpec>`; prewarms every workspace through `WorkspaceRegistry.acquire` so the first request doesn't pay the cold-start cost; passes the workspace map + loader to both plugins. Help text reflects the new env vars. |

### Backwards compatibility

| Embedder | Before | After |
|---|---|---|
| `pnpm studio --run runs/foo.svrun --workspace ./foo` (local Studio UI) | Works | **Works** (single-tenant back-compat; the run becomes the default workspace) |
| Phase-2 embedder using bare `/__studio/visual.html` after the upgrade | Works | **Works if** `--run` or `HYPIT_STUDIO_DEFAULT_WORKSPACE` is set |
| Embedder using `/__studio/<id>/<rest>` | n/a | **Works** (new primary path) |
| Bare `/__studio/<rest>` with no default configured | 404 | **404** (strict — see Phase 1 docs) |

### Embedder recipes (Phase 3)

**Two workspaces, side-by-side, each in its own iframe:**

```html
<iframe src="https://studio.example.com/__studio/L0FwcHMvbWUvcHJvai9mb28/visual.html"
        sandbox="allow-scripts allow-same-origin"
        width="640" height="360"></iframe>
<iframe src="https://studio.example.com/__studio/L0FwcHMvbWUvcHJvai9iYXI/visual.html"
        sandbox="allow-scripts allow-same-origin"
        width="640" height="360"></iframe>
```

**Demultiplex SSE by workspace id:**

```js
const source = new EventSource("https://studio.example.com/__studio/events");
const snapshots = new Map();
source.addEventListener("studio:snapshot", (e) => {
  const { workspaceId, ...snapshot } = JSON.parse(e.data);
  snapshots.set(workspaceId, snapshot);
  render(); // repaint every iframe from its own snapshot
});
source.addEventListener("studio:error", (e) => {
  const { workspaceId, error } = JSON.parse(e.data);
  showError(workspaceId, error);
});
source.addEventListener("studio:feedback-changed", (e) => {
  const { workspaceId } = JSON.parse(e.data);
  refetchFeedback(workspaceId);
});
```

**Cross-origin write to a specific workspace:**

```js
const WS = "L0FwcHMvbWUvcHJvai9mb28";
await fetch(`https://studio.example.com/__studio/${WS}/mutation`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "authorization": `Bearer ${STUDIO_TOKEN}`,
  },
  body: JSON.stringify({
    type: "parameter.adjust",
    revision: snapshots.get(WS).revision,
    entityId: "clip-3",
    parameterId: "caption-size",
    value: "large",
  }),
});
```

### Operator runbook (multi-tenant)

```bash
# Pre-register two workspaces.
export HYPIT_STUDIO_WORKSPACES="/Users/me/proj/foo::runs/foo.svrun,/Users/me/proj/bar::runs/bar.svrun"
export HYPIT_STUDIO_DEFAULT_WORKSPACE=/Users/me/proj/foo
export HYPIT_STUDIO_HOST=0.0.0.0
export HYPIT_STUDIO_PUBLIC_ORIGINS=https://myapp.test
export HYPIT_STUDIO_MAX_WORKSPACES=8
# HYPIT_STUDIO_TOKEN auto-generated + printed at startup.

pnpm studio --port 5179

# Banner prints every registered workspace and its base64url id:
#
#   Project            /Users/me/proj/foo
#   Workspaces         2 registered (max 8, LRU evicted)
#     L0FwcHMvbWUvcHJvai9mb28  /Users/me/proj/foo
#     L0FwcHMvbWUvcHJvai9iYXI  /Users/me/proj/bar
#   Default workspace  L0FwcHMvbWUvcHJvai9mb28
#   Bind host          0.0.0.0
#   Public origins     https://myapp.test
#   Write token        9b3X...yq  (auto-generated for this session)
#   Embed SSE          GET /__studio/events  (snapshot / error / feedback-changed; events tagged with workspaceId)
```

```bash
# Verify multi-tenant session isolation.
curl -sN http://localhost:5179/__studio/L0FwcHMvbWUvcHJvai9mb28/session | jq .revision
curl -sN http://localhost:5179/__studio/L0FwcHMvbWUvcHJvai9iYXI/session | jq .revision

# SSE tags every event with its workspaceId:
curl -sN http://localhost:5179/__studio/events | head -10
# Expect:
#   : ok
#   event: studio:snapshot
#   data: {"workspaceId":"L0FwcHMvbWUvcHJvai9mb28","revision":1,…}
#   event: studio:snapshot
#   data: {"workspaceId":"L0FwcHMvbWUvcHJvai9iYXI","revision":1,…}

# Unknown workspaceId → 404.
curl -s -o /dev/null -w "%{http_code}\n" \
  http://localhost:5179/__studio/ws_unknown/session
# Expect: 404
```