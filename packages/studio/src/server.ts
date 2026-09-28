import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ViteDevServer } from "vite";

import { corsHeaders, frameAncestors } from "./cors.js";
import type { PublicOrigins } from "./cors.js";
import { workspaceIdFor, WorkspaceRegistry, WorkspaceSession } from "./workspace-registry.js";
import type { LoaderResult } from "./workspace-registry.js";
import { SseHub, SSE_RESPONSE_HEADERS } from "./sse.js";

/**
 * Phase 3 — one pre-registered workspace. The dispatcher uses
 * `workspaceId` to route the request to the correct session.
 */
export type WorkspaceSpec = {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly runPath: string;
  readonly packageRoot: string;
};

/**
 * Phase 3 — `studioPlugin` is a thin dispatcher. Every workspace the
 * process can serve is registered at startup; the dispatcher looks up
 * the workspace id from the URL and delegates to the session.
 *
 * URL convention (Phase 3):
 *
 *   /__studio/<workspaceId>/<rest>    → workspace-bound request
 *   /__studio/<rest>                  → default workspace (first entry)
 *   /__studio/events                  → global SSE stream (workspaceId
 *                                       stamped on every payload)
 *
 * `workspaceIdFor(absolutePath)` = base64url(absolutePath).
 */
export type StudioPluginOptions = {
  readonly workspaceRegistry: WorkspaceRegistry;
  readonly sseHub: SseHub;
  readonly authToken: string | undefined;
  readonly corsConfig: PublicOrigins;
  /** Pre-registered workspaces, keyed by workspaceId. */
  readonly workspaces: ReadonlyMap<string, WorkspaceSpec>;
  /** Default workspace id for bare-path requests (`/__studio/<rest>`). */
  readonly defaultWorkspaceId: string | undefined;
  /** Shared loader that compiles a workspace from its spec. */
  readonly loader: (spec: WorkspaceSpec) => Promise<LoaderResult>;
};

function parseWorkspaceSelector(
  pathname: string,
): { readonly workspaceId: string | null; readonly rest: string } | "events" | null {
  if (!pathname.startsWith("/__studio/")) return null;
  const tail = pathname.slice("/__studio/".length);
  if (tail.length === 0) return null;
  if (tail === "events") return "events";
  const slash = tail.indexOf("/");
  if (slash < 0) {
    // Bare endpoint — no workspace id; fall back to default.
    return { workspaceId: null, rest: `/${tail}` };
  }
  const candidate = tail.slice(0, slash);
  if (candidate.length === 0) {
    return { workspaceId: null, rest: `/${tail.slice(1)}` };
  }
  return { workspaceId: candidate, rest: tail.slice(slash) };
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(value)}\n`);
}

export function studioPlugin(options: StudioPluginOptions): Plugin {
  let server: ViteDevServer | undefined;

  return {
    name: "hypit-studio",
    configureServer(value) {
      server = value;
      const corsConfig = options.corsConfig;

      // CORS + OPTIONS preflight for every /__studio/* path (workspaces +
      // the global SSE stream). Registered first so headers are present
      // before any other middleware writes the response.
      if (corsConfig.mode !== "none") {
        value.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? "/", "http://studio.hypit.local");
          if (!url.pathname.startsWith("/__studio/")) { next(); return; }
          for (const [name, val] of Object.entries(corsHeaders(request.headers.origin, corsConfig))) {
            response.setHeader(name, val);
          }
          if (url.pathname.endsWith("/visual.html")) {
            const csp = frameAncestors(corsConfig);
            if (csp !== undefined) response.setHeader("content-security-policy", csp);
          }
          if (request.method === "OPTIONS") {
            response.statusCode = 204;
            response.end();
            return;
          }
          next();
        });
      }

      // Global SSE stream — workspace-agnostic. Events are tagged with
      // workspaceId by SseHub.broadcast.
      value.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://studio.hypit.local");
        if (url.pathname !== "/__studio/events") { next(); return; }
        if (request.method !== "GET" && request.method !== "HEAD") { next(); return; }
        for (const [name, val] of Object.entries(SSE_RESPONSE_HEADERS)) {
          response.setHeader(name, val);
        }
        response.flushHeaders?.();
        response.write(": ok\n\n");
        options.sseHub.subscribe(response);
        return;
      });

      // Dispatcher: workspace-bound paths → session.handleRequest.
      value.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? "/", "http://studio.hypit.local");
        const selector = parseWorkspaceSelector(url.pathname);
        if (selector === null) { next(); return; }
        if (selector === "events") { next(); return; } // handled above

        let resolvedId: string;
        if (selector.workspaceId === null) {
          // Bare path → default workspace.
          if (options.defaultWorkspaceId === undefined) {
            json(response, 404, {
              error: "Workspace id required. Use /__studio/<workspaceId>/<rest>, or set --run / HYPIT_STUDIO_DEFAULT_WORKSPACE for a default.",
            });
            return;
          }
          resolvedId = options.defaultWorkspaceId;
        } else {
          resolvedId = selector.workspaceId;
        }

        const spec = options.workspaces.get(resolvedId);
        if (spec === undefined) {
          json(response, 404, {
            error: `Unknown workspaceId ${resolvedId}. This Studio process serves: ${[...options.workspaces.keys()].join(", ") || "(none)"}`,
          });
          return;
        }

        try {
          const session = await options.workspaceRegistry.acquire({
            workspaceId: spec.workspaceId,
            workspaceRoot: spec.workspaceRoot,
            runPath: spec.runPath,
            packageRoot: spec.packageRoot,
            loader: () => options.loader(spec),
          });
          session.setViteServer(server);
          await session.handleRequest(
            request.method ?? "GET",
            selector.rest,
            url,
            request.headers,
            request as IncomingMessage,
            response,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!response.headersSent) json(response, 500, { error: message });
          else response.destroy(error instanceof Error ? error : new Error(message));
        }
      });
    },
    async closeBundle() {
      await options.workspaceRegistry.close();
    },
  };
}

export { workspaceIdFor };