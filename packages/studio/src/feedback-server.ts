import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { relative } from "node:path";
import type { Plugin } from "vite";
import { createFeedbackStore, FeedbackConflict } from "./feedback-store.js";
import { readFeedbackMutation } from "./feedback.js";
import { allowsStudioMutationWithToken } from "./mutation-origin.js";
import { corsHeaders } from "./cors.js";
import type { PublicOrigins } from "./cors.js";
import type { SseHub } from "./sse.js";
import type { FeedbackDocument, FeedbackView } from "./feedback.js";

/**
 * Phase 3 — feedback is per-workspace. The plugin keeps one
 * `FeedbackStore` plus one `FEEDBACK.json` watcher per registered
 * workspace, lazy-created on first access. The dispatch is the same
 * URL convention as `studioPlugin`: `/__studio/<id>/feedback` is
 * workspace-bound; `/__studio/feedback` falls back to the default
 * workspace.
 */
export function studioFeedbackPlugin(options: {
  readonly workspaces: ReadonlyMap<string, { readonly workspaceRoot: string; readonly runPath: string }>;
  readonly defaultWorkspaceId: string | undefined;
  readonly corsConfig: PublicOrigins;
  readonly authToken: string | undefined;
  readonly sseHub: SseHub;
}): Plugin {
  type PerWorkspace = {
    store: ReturnType<typeof createFeedbackStore>;
    run: string;
    view: (document: FeedbackDocument) => FeedbackView;
    watcher: FSWatcher;
  };
  const perWorkspace = new Map<string, PerWorkspace>();

  const openFor = (workspaceId: string): PerWorkspace | undefined => {
    const existing = perWorkspace.get(workspaceId);
    if (existing !== undefined) return existing;
    const spec = options.workspaces.get(workspaceId);
    if (spec === undefined) return undefined;
    const store = createFeedbackStore(spec.workspaceRoot);
    const run = relative(spec.workspaceRoot, spec.runPath).replaceAll("\\", "/");
    const view = (document: FeedbackDocument): FeedbackView => ({
      file: "FEEDBACK.json", run, comments: document.comments.filter((comment) => comment.run === run),
    });
    const watcher = watch(spec.workspaceRoot, (_event, filename) => {
      if (filename === null || filename.toString() === "FEEDBACK.json") {
        // Broadcast through the SSE hub; events are stamped with the
        // workspace id by SseHub.broadcast.
        options.sseHub.broadcast("studio:feedback-changed", {}, workspaceId);
      }
    });
    const created: PerWorkspace = { store, run, view, watcher };
    perWorkspace.set(workspaceId, created);
    return created;
  };

  return {
    name: "hypit-studio-feedback",
    configureServer(server) {
      // Close every per-workspace watcher on HTTP server shutdown.
      server.httpServer?.once("close", () => {
        for (const entry of perWorkspace.values()) {
          try { entry.watcher.close(); } catch { /* ignore */ }
        }
        perWorkspace.clear();
      });

      // CORS preflight for every /__studio/*feedback path.
      if (options.corsConfig.mode !== "none") {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? "/", "http://studio.hypit.local");
          if (!url.pathname.startsWith("/__studio/") || !url.pathname.endsWith("/feedback")) { next(); return; }
          for (const [name, val] of Object.entries(corsHeaders(request.headers.origin, options.corsConfig))) {
            response.setHeader(name, val);
          }
          if (request.method === "OPTIONS") {
            response.statusCode = 204;
            response.end();
            return;
          }
          next();
        });
      }

      server.middlewares.use((request, response, next) => {
        const url = new URL(request.url ?? "/", "http://studio.hypit.local");
        if (!url.pathname.startsWith("/__studio/") || !url.pathname.endsWith("/feedback")) { next(); return; }

        // Resolve workspaceId from the URL prefix, mirroring studioPlugin.
        const tail = url.pathname.slice("/__studio/".length);
        let resolvedId: string | null;
        let rest: string;
        const slash = tail.indexOf("/");
        if (slash < 0) {
          resolvedId = null;
          rest = `/${tail}`;
        } else {
          const candidate = tail.slice(0, slash);
          if (candidate.length === 0) {
            resolvedId = null;
            rest = `/${tail.slice(1)}`;
          } else {
            resolvedId = candidate;
            rest = tail.slice(slash);
          }
        }
        if (rest !== "/feedback") { next(); return; }

        const workspaceId = resolvedId ?? options.defaultWorkspaceId;
        if (workspaceId === undefined) {
          response.statusCode = 404;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "Workspace id required for feedback." }));
          return;
        }

        const entry = openFor(workspaceId);
        if (entry === undefined) {
          response.statusCode = 404;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: `Unknown workspaceId ${workspaceId}.` }));
          return;
        }

        if (request.method === "POST" && !allowsStudioMutationWithToken(request.headers, options.authToken)) {
          response.statusCode = 403;
          response.setHeader("content-type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "Studio mutation must come from this local Studio session." }));
          return;
        }
        response.setHeader("content-type", "application/json; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        void (async () => {
          try {
            if (request.method === "GET") {
              response.end(JSON.stringify(entry.view(await entry.store.read())));
              return;
            }
            if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const mutation = readFeedbackMutation(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            const comment = mutation.type === "delete" ? mutation.before : mutation.comment;
            if (comment.run !== entry.run) throw new Error("The comment belongs to another Run.");
            const result = entry.view(await entry.store.mutate(mutation));
            response.end(JSON.stringify(result));
            options.sseHub.broadcast("studio:feedback-changed", {}, workspaceId);
          } catch (error) {
            response.statusCode = error instanceof FeedbackConflict ? 409 : 400;
            response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
          }
        })();
      });
    },
  };
}