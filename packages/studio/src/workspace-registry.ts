import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { IncomingHttpHeaders, ServerResponse } from "node:http";

import type { ViteDevServer } from "vite";
import type { BuildResultFileRange } from "@hypit/build-result";
import type { HyperframesDocument } from "@hypit/hyperframes";
import type { StudioTemporalInstantProjection } from "@hypit/studio-adapter";

import type { StudioBuildLibrary } from "./build-library.js";
import type { ServedFile } from "./compile.js";
import type { StudioDomain } from "./domain.js";
import { loadStudioRun } from "./run.js";
import { allowsStudioMutationWithToken } from "./mutation-origin.js";
import { parameterAuthorValue, parameterOption, serializeParameterValue, serializeAttributeGroup, validateParameterValue } from "./parameter-values.js";
import { readStudioSession } from "./session.js";
import type { Range, StudioFailure, StudioLibraryRequest, StudioLibraryView, StudioMutation, StudioSnapshot } from "./shared.js";
import type { SseHub } from "./sse.js";
import { createStudioStoryboard } from "./storyboard.js";
import type { StudioStoryboard } from "./storyboard.js";
import type { StudioCompanionRegistry } from "./studio-registry.js";
import { findSurfacePreview } from "./surface-preview.js";
import { formatTemporalPointEdit, semanticGestureSpan } from "./temporal-edit.js";
import { replaceSourceFiles } from "./source-transaction.js";

/**
 * Phase 3 — every workspace served by the Studio process owns one
 * `WorkspaceSession`. The session carries the compile state that used
 * to live as closure-local variables inside `studioPlugin` (Phases 1/2),
 * plus the loaded `StudioDomain` and `StudioBuildLibrary`.
 *
 * Sessions are created lazily by `WorkspaceRegistry.acquire`. A session
 * may be evicted (LRU) while the process is running, which closes its
 * `buildLibrary` and the per-workspace file watchers. The next request
 * for the same workspace id rebuilds from scratch.
 */

export type SessionOptions = {
  readonly workspaceId: string;
  readonly workspaceRoot: string;
  readonly runPath: string;
  readonly packageRoot: string;
  readonly domain: StudioDomain;
  readonly registry: StudioCompanionRegistry;
  readonly buildLibrary: StudioBuildLibrary | undefined;
  readonly sseHub: SseHub;
  readonly authToken: string | undefined;
};

type Patch = {
  readonly path: string;
  readonly range: Range;
  readonly replacement: string;
  readonly preimage: string;
};

class StudioMutationRejected extends Error {}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(`${JSON.stringify(value)}\n`);
}

function requestedByteRange(value: string | undefined, size: number): BuildResultFileRange | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value.trim());
  if (match === null || (match[1]!.length === 0 && match[2]!.length === 0) || size === 0) {
    throw new RangeError("requested byte range is not satisfiable");
  }
  if (match[1]!.length === 0) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new RangeError("requested byte range is not satisfiable");
    return { start: Math.max(0, size - suffix), endExclusive: size };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2]!.length === 0 ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start < 0
    || start >= size || requestedEnd < start) {
    throw new RangeError("requested byte range is not satisfiable");
  }
  return { start, endExclusive: Math.min(size, requestedEnd + 1) };
}

function rangeOf(error: unknown): Range | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const range = (error as { readonly range?: unknown }).range;
  if (typeof range === "object" && range !== null && "start" in range && "end" in range) {
    return range as Range;
  }
  const offset = (error as { readonly offset?: unknown }).offset;
  return typeof offset === "number" && Number.isFinite(offset)
    ? { start: offset, end: offset + 1 }
    : undefined;
}

function conflict(error: unknown): boolean {
  return error instanceof Error && /changed outside Studio|Source changed outside Studio|mutation is already in progress/u.test(error.message);
}

/**
 * Phase 3 — one Studio session per workspace. Compiles its `.svrun`,
 * tracks the current snapshot, and serves every `/__studio/<id>/...`
 * endpoint for that workspace.
 *
 * The session is responsible for its own lifetime: `close()` tears down
 * the build library and all per-workspace file watchers. The registry
 * calls `close()` when a session is LRU-evicted or when the Studio
 * process shuts down.
 */
export class WorkspaceSession {
  readonly #workspaceId: string;
  readonly #workspaceRoot: string;
  readonly #runPath: string;
  readonly #domain: StudioDomain;
  readonly #registry: StudioCompanionRegistry;
  readonly #buildLibrary: StudioBuildLibrary | undefined;
  readonly #sseHub: SseHub;
  readonly #authToken: string | undefined;

  // Compile state (moved verbatim from the Phase-1/2 studioPlugin closure).
  #snapshot: StudioSnapshot | undefined;
  #visualHtml: string | undefined;
  #visualDocument: HyperframesDocument | undefined;
  #failure: StudioFailure | undefined;
  #material: ReadonlyMap<string, ServedFile> = new Map();
  #revision = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #mutating = false;
  #publishing = 0;
  #requestedRevision = 0;
  #currentSource: string;
  #allowedSourceFiles = new Set<string>();
  readonly #watched = new Map<string, FSWatcher>();
  readonly #watchedFiles = new Set<string>();
  readonly #storyboards = new Map<string, Promise<StudioStoryboard>>();

  // Lifecycle — bumped on every acquire so the registry can LRU-evict.
  #lastUsed = Date.now();

  // Phase 3 — set by `studioPlugin.configureServer` so the broadcast
  // helper can also reach the Vite HMR WebSocket that the local Studio
  // UI uses. Optional: when unset, only the SSE hub is notified.
  #server: ViteDevServer | undefined;

  constructor(options: SessionOptions) {
    this.#workspaceId = options.workspaceId;
    this.#workspaceRoot = options.workspaceRoot;
    this.#runPath = options.runPath;
    this.#domain = options.domain;
    this.#registry = options.registry;
    this.#buildLibrary = options.buildLibrary;
    this.#sseHub = options.sseHub;
    this.#authToken = options.authToken;
    this.#currentSource = options.runPath;
  }

  get workspaceId(): string { return this.#workspaceId; }
  get workspaceRoot(): string { return this.#workspaceRoot; }
  get lastUsed(): number { return this.#lastUsed; }
  get size(): number { return this.#watched.size + this.#storyboards.size + (this.#snapshot === undefined ? 0 : 1); }

  /** Bump the LRU timestamp. Called by the registry on every acquire. */
  touch(): void {
    this.#lastUsed = Date.now();
  }

  setViteServer(server: ViteDevServer | undefined): void {
    this.#server = server;
  }

  /**
   * Phase 3 — Phase 2's `broadcast()` helper, renamed and workspace-aware.
   * Fans events out to the Vite HMR WebSocket (local Studio UI) and the
   * shared SSE hub (external embedders). The hub stamps every event
   * payload with this session's `workspaceId` so embedders can
   * demultiplex the single global `/__studio/events` stream.
   */
  #broadcast(event: "studio:snapshot" | "studio:error", data: unknown): void {
    this.#server?.ws.send({ type: "custom", event, data });
    this.#sseHub.broadcast(event, data, this.#workspaceId);
  }

  #readLibrary = async (request: StudioLibraryRequest): Promise<StudioLibraryView> => {
    return await this.#buildLibrary?.library(request) ?? {
      section: request.section,
      environment: this.#workspaceRoot,
      tasks: [],
      artifacts: [],
    };
  };

  #watchSource(path: string): void {
    const absolute = resolve(path);
    this.#watchedFiles.add(absolute);
    const directory = dirname(absolute);
    if (this.#watched.has(directory)) return;
    try {
      const watcher = watch(directory, (_event, filename) => {
        const changed = filename === null ? undefined : resolve(directory, filename.toString());
        if (!this.#mutating && (changed === undefined || this.#watchedFiles.has(changed))) this.#schedule();
      });
      watcher.on("error", () => {
        watcher.close();
        if (this.#watched.get(directory) === watcher) this.#watched.delete(directory);
      });
      this.#watched.set(directory, watcher);
    } catch {
      // Some Hosts may report virtual Source ids. They are still recompiled
      // whenever a real Source revision is scheduled; they simply emit no file event.
    }
  }

  async #publish(attempt: number, notify = true): Promise<void> {
    this.#publishing += 1;
    try {
      // SVML and SVRun form one Studio source of truth. Recompile both for
      // every revision so a new Author graph is never executed through an old
      // Run plan.
      const run = await loadStudioRun({
        run: this.#runPath,
        domain: this.#domain,
        registry: this.#registry,
        ...(this.#buildLibrary === undefined ? {} : { buildLibrary: this.#buildLibrary }),
      });
      this.#currentSource = run.authorSource;
      this.#watchSource(this.#runPath);
      for (const unit of run.source.compiled.closure.units) this.#watchSource(unit.id);
      this.#allowedSourceFiles = new Set([
        this.#runPath,
        run.authorSource,
        ...run.source.compiled.closure.units.map((unit) => unit.id).filter((path) => existsSync(path)),
      ].map((path) => resolve(path)));
      const result = await readStudioSession({
        domain: this.#domain,
        registry: this.#registry,
        run,
        ...(this.#buildLibrary?.transientExecution === undefined
          ? {}
          : { transientExecution: this.#buildLibrary.transientExecution }),
        revision: attempt,
        sourcePath: relative(this.#workspaceRoot, run.authorSource),
        workspaceRoot: this.#workspaceRoot,
      });
      if (attempt !== this.#requestedRevision) return;
      this.#revision = attempt;
      this.#snapshot = result.snapshot;
      this.#visualHtml = result.visualHtml;
      this.#visualDocument = result.document;
      this.#material = result.material;
      this.#failure = undefined;
      if (notify) this.#broadcast("studio:snapshot", this.#snapshot);
    } catch (error) {
      if (attempt !== this.#requestedRevision) return;
      this.#revision = attempt;
      const range = rangeOf(error);
      this.#failure = {
        revision: this.#revision,
        error: error instanceof Error ? error.message : String(error),
        ...(range === undefined ? {} : { range }),
      };
      if (notify) this.#broadcast("studio:error", this.#failure);
    } finally {
      this.#publishing -= 1;
    }
  }

  #schedule(): void {
    const attempt = ++this.#requestedRevision;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#publish(attempt);
    }, 80);
  }

  async #applyTransaction(
    patches: readonly Patch[],
    expectedRevision: number,
  ): Promise<ReadonlyMap<string, string>> {
    const sourceRevision = this.#failure !== undefined && (this.#snapshot === undefined || this.#failure.revision > this.#snapshot.revision)
      ? this.#failure.revision
      : this.#snapshot?.revision;
    if (sourceRevision !== undefined && expectedRevision !== sourceRevision) {
      throw new Error("The Source changed outside Studio.");
    }
    const grouped = new Map<string, Patch[]>();
    for (const patch of patches) {
      if (isAbsolute(patch.path)) throw new Error("Studio patches must use workspace-relative paths.");
      const absolute = resolve(this.#workspaceRoot, patch.path);
      const rel = relative(this.#workspaceRoot, absolute);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !this.#allowedSourceFiles.has(absolute)) {
        throw new Error(`Studio cannot write source file ${patch.path}.`);
      }
      if (!Number.isInteger(patch.range.start) || !Number.isInteger(patch.range.end)
        || patch.range.start < 0 || patch.range.end < patch.range.start) {
        throw new Error(`Invalid source range for ${patch.path}.`);
      }
      const held = grouped.get(absolute) ?? [];
      held.push(patch);
      grouped.set(absolute, held);
    }
    const nextFiles = new Map<string, string>();
    const previousFiles = new Map<string, string>();
    for (const [absolute, filePatches] of grouped) {
      const text = await readFile(absolute, "utf8");
      previousFiles.set(absolute, text);
      const ordered = [...filePatches].sort((left, right) => left.range.start - right.range.start);
      for (let index = 1; index < ordered.length; index += 1) {
        const previous = ordered[index - 1]!;
        const current = ordered[index]!;
        if (current.range.start < previous.range.end) {
          throw new Error(`Overlapping source patches are not allowed: ${relative(this.#workspaceRoot, absolute)}.`);
        }
      }
      let next = text;
      for (const patch of [...filePatches].sort((left, right) => right.range.start - left.range.start)) {
        if (patch.range.end > text.length) throw new Error(`Source range exceeds file: ${patch.path}.`);
        const current = next.slice(patch.range.start, patch.range.end);
        if (current !== patch.preimage) throw new Error(`Source changed outside Studio: ${patch.path}.`);
        next = `${next.slice(0, patch.range.start)}${patch.replacement}${next.slice(patch.range.end)}`;
      }
      if (next !== text) nextFiles.set(absolute, next);
    }
    await replaceSourceFiles(nextFiles);
    return new Map([...previousFiles].filter(([absolute]) => nextFiles.has(absolute)));
  }

  #currentClip(entityId: string): StudioSnapshot["tracks"][number]["clips"][number] {
    const found = this.#snapshot?.tracks.flatMap((track) => track.clips).find((clip) => clip.id === entityId);
    if (found === undefined) throw new Error(`Studio entity ${entityId} no longer exists.`);
    return found;
  }

  async #timelinePatches(
    mutation: Extract<StudioMutation, { readonly type: "timeline.adjust" }>,
  ): Promise<readonly Patch[]> {
    const clip = this.#currentClip(mutation.entityId);
    const handle = clip.editHandles.find((candidate) =>
      candidate.operation === "timeline.adjust"
      && candidate.gesture === mutation.gesture
      && candidate.enabled);
    if (handle === undefined) throw new Error(`Entity ${mutation.entityId} does not allow ${mutation.gesture}.`);

    const temporal = handle.temporal;
    if (temporal === undefined) throw new Error("This timeline entity has no authoring authority.");
    if (temporal.kind !== mutation.target.kind) {
      throw new Error(`This timeline entity requires a ${temporal.kind} mutation target.`);
    }
    const startFrame = mutation.target.kind === "instant" ? mutation.target.frame : mutation.target.startFrame;
    const endFrameExclusive = mutation.target.kind === "instant" ? mutation.target.frame + 1 : mutation.target.endFrameExclusive;
    if (!Number.isInteger(startFrame) || startFrame < 0
      || (mutation.target.kind === "window"
        && (!Number.isInteger(endFrameExclusive) || endFrameExclusive <= startFrame))) {
      throw new Error("A timeline target must use valid whole frames.");
    }
    if (temporal.kind === "window") {
      if (mutation.gesture === "move" && handle.semantic?.kind !== "selection"
        && endFrameExclusive - startFrame !== clip.endFrameExclusive - clip.startFrame) {
        throw new Error("Move must preserve the Window duration.");
      }
      if (mutation.gesture === "trim-start" && endFrameExclusive !== clip.endFrameExclusive) {
        throw new Error("Trim start cannot change the Window end.");
      }
      if (mutation.gesture === "trim-end" && startFrame !== clip.startFrame) {
        throw new Error("Trim end cannot change the Window start.");
      }
    } else if (mutation.gesture !== "move") {
      throw new Error("An Instant only supports move.");
    }

    const patches: Patch[] = [];
    const semanticTarget = mutation.target.semantic;
    if (handle.semantic !== undefined && semanticTarget === undefined) throw new Error("A semantic edit requires explicit target anchors.");
    if (semanticTarget !== undefined) {
      if (handle.semantic?.kind !== semanticTarget.kind) {
        throw new Error(`Entity ${mutation.entityId} is not bound to a writable ${semanticTarget.kind}.`);
      }
      const current = this.#snapshot;
      const script = current?.script;
      if (current === undefined || script === undefined || current.semantic === undefined) throw new Error("Studio has no writable Script source map.");
      if (handle.semantic.narrativeId !== current.semantic.narrativeId
        || script.narrativeId !== current.semantic.narrativeId) {
        throw new Error("The timeline entity and writable Script do not belong to the selected Narrative.");
      }
      const projected = semanticGestureSpan(current.semantic.anchors, handle, semanticTarget);
      if (projected === undefined || projected.startFrame !== startFrame || projected.endFrameExclusive !== endFrameExclusive) {
        throw new Error("The semantic edit does not produce the requested timeline projection.");
      }
      const absolute = resolve(this.#workspaceRoot, script.sourcePath);
      const source = await readFile(absolute, "utf8");
      if (script.content.start < 0 || script.content.end < script.content.start || script.content.end > source.length) {
        throw new Error("The current Script source range is invalid.");
      }
      const body = source.slice(script.content.start, script.content.end);
      const replacement = this.#registry.adjustScript({
        companion: script.companion,
        sourceName: script.sourcePath,
        source: body,
        adjustment: semanticTarget.kind === "selection"
          ? {
              kind: "selection",
              id: handle.semantic.id,
              startAnchorId: semanticTarget.startAnchorId,
              endAnchorId: semanticTarget.endAnchorId,
            }
          : { kind: "moment", id: handle.semantic.id, anchorId: semanticTarget.anchorId },
      });
      if (replacement !== body) patches.push({
        path: relative(this.#workspaceRoot, absolute), range: script.content, replacement, preimage: body,
      });
    }

    const source = (role: "start" | "end" | "duration") =>
      handle.sources?.find((candidate) => candidate.role === role)?.source;
    const frame = (value: number): string => `${value}f`;
    const semanticFrame = (endpoint: StudioTemporalInstantProjection): number | undefined => {
      if (endpoint.authority.kind !== "semantic" || semanticTarget === undefined || handle.semantic === undefined) return undefined;
      if (endpoint.source.kind === "selection" && semanticTarget.kind === "selection"
        && endpoint.source.id === handle.semantic.id) {
        const anchorId = endpoint.authority.boundary === "start"
          ? semanticTarget.startAnchorId
          : semanticTarget.endAnchorId;
        return this.#snapshot?.semantic?.anchors.find((anchor) => anchor.id === anchorId)?.frame;
      }
      if (endpoint.source.kind === "moment" && semanticTarget.kind === "moment"
        && endpoint.source.id === handle.semantic.id) {
        return this.#snapshot?.semantic?.anchors.find((anchor) => anchor.id === semanticTarget.anchorId)?.frame;
      }
      return undefined;
    };
    const projectionBaseFrame = (endpoint: StudioTemporalInstantProjection): number | undefined => {
      if (endpoint.reference === "absolute") return undefined;
      if (endpoint.reference === "program.start") return 0;
      if (endpoint.reference === "program.end") return this.#snapshot?.space.frameCount;
      const id = endpoint.source.id;
      if (id === undefined) return undefined;
      if (endpoint.reference === "selection.start" || endpoint.reference === "selection.end") {
        const selection = this.#snapshot?.semantic?.selections.find((candidate) => candidate.id === id);
        return endpoint.reference === "selection.start" ? selection?.startFrame : selection?.endFrameExclusive;
      }
      if (endpoint.reference === "segment.start" || endpoint.reference === "segment.end") {
        const segment = this.#snapshot?.semantic?.segments.find((candidate) => candidate.id === id);
        return endpoint.reference === "segment.start" ? segment?.startFrame : segment?.endFrameExclusive;
      }
      return this.#snapshot?.semantic?.moments.find((candidate) => candidate.id === id)?.frame;
    };
    const projectedPointValue = (endpoint: StudioTemporalInstantProjection, desired: number): string =>
      formatTemporalPointEdit(endpoint.reference, desired, projectionBaseFrame(endpoint));
    const writeEndpoint = (
      endpoint: StudioTemporalInstantProjection,
      desired: number,
      role: "start" | "end",
    ): void => {
      if (desired === endpoint.frame) return;
      if (endpoint.authority.kind === "fixed") throw new Error(`The ${role} endpoint has no timeline write target.`);
      if (endpoint.authority.kind === "semantic") {
        if (semanticFrame(endpoint) !== desired) throw new Error(`The ${role} endpoint does not match its semantic Anchor.`);
        return;
      }
      if (endpoint.authority.relation !== "direct") return;
      const author = source(role);
      if (author === undefined) throw new Error(`The ${role} projection has no writable Source binding.`);
      patches.push({ ...author, replacement: projectedPointValue(endpoint, desired) });
    };
    if (temporal.kind === "instant") {
      writeEndpoint(temporal, startFrame, "start");
    } else {
      writeEndpoint(temporal.start, startFrame, "start");
      writeEndpoint(temporal.end, endFrameExclusive, "end");
      const derived = [temporal.start, temporal.end].find((endpoint) =>
        endpoint.authority.kind === "parameter" && endpoint.authority.relation !== "direct");
      if (derived !== undefined
        && endFrameExclusive - startFrame !== temporal.endFrameExclusive - temporal.startFrame) {
        const author = source("duration");
        if (author === undefined) throw new Error("The projected duration has no writable Source binding.");
        patches.push({ ...author, replacement: frame(endFrameExclusive - startFrame) });
      }
    }
    return patches.filter((patch) => patch.replacement !== patch.preimage);
  }

  async #mutationPatches(mutation: StudioMutation): Promise<readonly Patch[]> {
    if (mutation.type === "timeline.adjust") return this.#timelinePatches(mutation);
    const clip = this.#currentClip(mutation.entityId);
    const parameter = clip.inspector.find((candidate) => candidate.id === mutation.parameterId);
    if (parameter?.edit === undefined) {
      throw new Error(`Entity ${mutation.entityId} has no writable parameter ${mutation.parameterId}.`);
    }
    const authorValue = parameterAuthorValue(parameter, mutation.value);
    if (parameter.schema !== undefined) {
      validateParameterValue(authorValue, parameter.schema, parameter.label);
    } else if (parameter.control === "boolean" && typeof mutation.value !== "boolean") {
      throw new Error(`${parameter.label} expects true or false.`);
    } else if (parameter.control === "number" && (typeof mutation.value !== "number" || !Number.isFinite(mutation.value))) {
      throw new Error(`${parameter.label} expects a number.`);
    } else if ((parameter.control === "text" || parameter.control === "color")
      && typeof mutation.value !== "string") {
      throw new Error(`${parameter.label} expects text.`);
    }
    if (parameter.options !== undefined && !parameter.options.some(option => parameterOption(option).value === authorValue)) {
      throw new Error(`${parameter.label} does not accept ${mutation.value}.`);
    }
    if (parameter.control === "color") validateParameterValue(authorValue, { kind: "string", format: "color" }, parameter.label);
    if (parameter.edit.attributes) {
      const replacement = serializeAttributeGroup(parameter, authorValue);
      return replacement === parameter.edit.source.preimage ? [] : [{ ...parameter.edit.source, replacement }];
    }
    const encoded = serializeParameterValue(authorValue, parameter.edit.language);
    const replacement = `${parameter.edit.source.prefix ?? ""}${encoded}${parameter.edit.source.suffix ?? ""}`;
    return replacement === parameter.edit.source.preimage ? [] : [{
      ...parameter.edit.source,
      replacement,
    }];
  }

  async #commitMutation(mutation: StudioMutation): Promise<number> {
    if (this.#mutating) throw new Error("A Studio author mutation is already in progress.");
    if (this.#timer !== undefined || this.#publishing > 0 || this.#snapshot === undefined
      || mutation.revision !== this.#snapshot.revision || this.#requestedRevision !== this.#snapshot.revision
      || (this.#failure !== undefined && this.#failure.revision >= this.#snapshot.revision)) {
      throw new Error("The Source changed outside Studio.");
    }
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#mutating = true;
    try {
      const patches = await this.#mutationPatches(mutation);
      if (patches.length === 0) return this.#snapshot.revision;
      const previous = await this.#applyTransaction(patches, mutation.revision);
      const attempt = ++this.#requestedRevision;
      await this.#publish(attempt, false);
      if (this.#failure?.revision !== attempt) {
        this.#broadcast("studio:snapshot", this.#snapshot);
        return attempt;
      }
      const rejected = this.#failure.error;
      await replaceSourceFiles(previous);
      await this.#publish(++this.#requestedRevision, false);
      this.#broadcast("studio:snapshot", this.#snapshot);
      throw new StudioMutationRejected(rejected);
    } finally {
      this.#mutating = false;
    }
  }

  /** Initial compile — kicked off by the registry after construction. */
  async initialCompile(): Promise<void> {
    const attempt = ++this.#requestedRevision;
    await this.#publish(attempt, false);
    // Notify subscribers of the first snapshot; we set notify=false above
    // because the constructor runs before the Vite server exists.
    if (this.#snapshot !== undefined) this.#broadcast("studio:snapshot", this.#snapshot);
  }

  /**
   * Phase 3 — handle one HTTP request scoped to this workspace. The path
   * passed in is the *workspace-stripped* path (e.g. `/session`,
   * `/material/<id>`); the dispatcher in `studioPlugin` removes the
   * `/__studio/<id>/` prefix before delegating.
   */
  async handleRequest(
    method: string,
    path: string,
    url: URL,
    headers: IncomingHttpHeaders,
    request: NodeJS.ReadableStream,
    response: ServerResponse,
  ): Promise<void> {
    this.#lastUsed = Date.now();

    if (method === "PUT" && path === "/source") {
      if (!allowsStudioMutationWithToken(headers, this.#authToken)) {
        json(response, 403, { error: "Cross-origin Studio mutations are prohibited." });
        return;
      }
      let acquired = false;
      try {
        if (this.#mutating || this.#timer !== undefined || this.#publishing > 0) {
          throw new Error("A Studio author mutation is already in progress.");
        }
        this.#mutating = true;
        acquired = true;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          readonly text?: unknown;
          readonly revision?: unknown;
          readonly path?: unknown;
        };
        if (typeof body.text !== "string" || typeof body.revision !== "number"
          || (body.path !== undefined && typeof body.path !== "string")) {
          json(response, 400, { error: "Expected source path, text and revision." });
          return;
        }
        const sourceRevision = this.#failure !== undefined && (this.#snapshot === undefined || this.#failure.revision > this.#snapshot.revision)
          ? this.#failure.revision
          : this.#snapshot?.revision;
        if (sourceRevision !== undefined && body.revision !== sourceRevision) {
          json(response, 409, { error: "The Source changed outside Studio." });
          return;
        }
        const sourcePath = body.path ?? relative(this.#workspaceRoot, this.#currentSource);
        const absolute = resolve(this.#workspaceRoot, sourcePath);
        if (isAbsolute(sourcePath) || !this.#allowedSourceFiles.has(absolute)) {
          throw new Error(`Studio cannot write source file ${sourcePath}.`);
        }
        const current = await readFile(absolute, "utf8");
        await this.#applyTransaction([{
          path: sourcePath,
          range: { start: 0, end: current.length },
          replacement: body.text,
          preimage: current,
        }], body.revision);
        const attempt = ++this.#requestedRevision;
        await this.#publish(attempt);
        json(response, 202, { revision: attempt });
      } catch (error) {
        json(response, conflict(error) ? 409 : 500, { error: error instanceof Error ? error.message : String(error) });
      } finally {
        if (acquired) this.#mutating = false;
      }
      return;
    }

    if (method === "PUT" && path === "/artifact-name") {
      if (!allowsStudioMutationWithToken(headers, this.#authToken)) {
        json(response, 403, { error: "Cross-origin Studio mutations are prohibited." });
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          build?: unknown; output?: unknown; displayName?: unknown;
        };
        if (typeof body.build !== "string" || typeof body.output !== "string"
          || (typeof body.displayName !== "string" && body.displayName !== null)) {
          json(response, 400, { error: "Expected Build, Output and displayName" });
          return;
        }
        if (this.#buildLibrary === undefined) throw new Error("Result Repository is unavailable");
        const displayName = await this.#buildLibrary.renameArtifact(body.build, body.output, body.displayName);
        json(response, 200, { displayName: displayName ?? null });
      } catch (error) {
        json(response, 422, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (method === "POST" && path === "/mutation") {
      if (!allowsStudioMutationWithToken(headers, this.#authToken)) {
        json(response, 403, { error: "Cross-origin Studio mutations are prohibited." });
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<StudioMutation>;
        if ((body.type !== "timeline.adjust" && body.type !== "parameter.adjust")
          || typeof body.revision !== "number"
          || typeof body.entityId !== "string") {
          json(response, 400, { error: "Expected a Studio author mutation." });
          return;
        }
        if (body.type === "timeline.adjust"
          && (typeof body.gesture !== "string" || typeof body.target !== "object" || body.target === null)) {
          json(response, 400, { error: "Expected a timeline gesture and target." });
          return;
        }
        if (body.type === "parameter.adjust"
          && (typeof body.parameterId !== "string" || body.value === undefined)) {
          json(response, 400, { error: "Expected a parameter identity and value." });
          return;
        }
        const committed = await this.#commitMutation(body as StudioMutation);
        json(response, 200, { revision: committed });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        json(response, conflict(error) ? 409 : error instanceof StudioMutationRejected ? 422 : 500, { error: message });
      }
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      response.statusCode = 404;
      response.end();
      return;
    }

    if (path === "/visual.html" || path === "/document") {
      if (this.#timer !== undefined || this.#publishing > 0) {
        json(response, 409, { error: "Studio is compiling a Source change; capture after the updated preview is ready." });
        return;
      }
      if (this.#snapshot === undefined && this.#failure === undefined) await this.#publish(++this.#requestedRevision);
      if (this.#failure !== undefined || this.#visualHtml === undefined) {
        json(response, 500, this.#failure ?? { error: "Studio has no compiled picture." });
        return;
      }
      if (path === "/document") {
        json(response, 200, this.#visualDocument);
        return;
      }
      response.statusCode = 200;
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      response.end(method === "HEAD" ? undefined : this.#visualHtml);
      return;
    }

    if (path === "/session") {
      if (this.#snapshot === undefined && this.#failure === undefined) {
        const attempt = ++this.#requestedRevision;
        await this.#publish(attempt);
      }
      if (this.#failure !== undefined && (this.#snapshot === undefined || this.#failure.revision > this.#snapshot.revision)) {
        json(response, 500, this.#failure);
      } else if (this.#snapshot !== undefined) {
        json(response, 200, this.#snapshot);
      } else {
        json(response, 500, this.#failure);
      }
      return;
    }

    if (path === "/library") {
      const section = url.searchParams.get("section");
      if (section !== "tasks" && section !== "artifacts") {
        json(response, 400, { error: "Choose tasks or artifacts with the section parameter" });
        return;
      }
      const media = url.searchParams.get("media") ?? undefined;
      if (media !== undefined && media !== "image" && media !== "video" && media !== "audio") {
        json(response, 400, { error: "Choose image, video or audio with the media parameter" });
        return;
      }
      const before = url.searchParams.get("before") ?? undefined;
      const run = url.searchParams.get("run") ?? undefined;
      const build = url.searchParams.get("build") ?? undefined;
      void this.#readLibrary({ section, ...(media === undefined ? {} : { media }), ...(before === undefined ? {} : { before }),
        ...(run === undefined ? {} : { run }), ...(build === undefined ? {} : { build }) }).then(
          (view) => json(response, 200, view),
          (error) => json(response, 500, { error: error instanceof Error ? error.message : String(error) }),
        );
      return;
    }

    if (path === "/surface-preview") {
      const module = url.searchParams.get("module");
      const version = url.searchParams.get("version");
      const surface = url.searchParams.get("surface");
      const preview = module === null || version === null || surface === null
        ? undefined
        : findSurfacePreview(this.#domain, { name: module, version }, surface);
      if (preview === undefined) {
        response.statusCode = 404;
        response.end();
        return;
      }
      try {
        const bytes = await preview.open();
        response.statusCode = 200;
        response.setHeader("content-type", preview.mediaType);
        response.setHeader("cache-control", "no-store");
        if (method === "HEAD") response.end();
        else response.end(Buffer.from(bytes));
      } catch (error) {
        json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    const storyboardResource = /^\/storyboard\/(res_[a-zA-Z0-9._:-]+)$/u.exec(path)?.[1];
    if (storyboardResource !== undefined) {
      const file = this.#material.get(storyboardResource);
      if (file === undefined || !file.mediaType.startsWith("video/")) {
        response.statusCode = 404;
        response.end();
        return;
      }
      try {
        let pending = this.#storyboards.get(storyboardResource);
        if (pending === undefined) {
          pending = createStudioStoryboard(file);
          this.#storyboards.set(storyboardResource, pending);
        }
        const storyboard = await pending;
        response.statusCode = 200;
        response.setHeader("content-type", "image/png");
        response.setHeader("cache-control", "public, max-age=31536000, immutable");
        response.setHeader("x-hypit-storyboard-count", String(storyboard.count));
        response.setHeader("x-hypit-storyboard-columns", String(storyboard.columns));
        response.setHeader("x-hypit-storyboard-rows", String(storyboard.rows));
        response.setHeader("x-hypit-storyboard-tile-width", String(storyboard.tileWidth));
        response.setHeader("x-hypit-storyboard-tile-height", String(storyboard.tileHeight));
        response.setHeader("x-hypit-storyboard-sample-fps", String(storyboard.sampleFps));
        if (method === "HEAD") response.end();
        else response.end(Buffer.from(storyboard.bytes));
      } catch (error) {
        this.#storyboards.delete(storyboardResource);
        json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    const materialResource = /^\/material\/(res_[a-zA-Z0-9._:-]+)$/u.exec(path)?.[1];
    if (materialResource !== undefined) {
      const file = this.#material.get(materialResource);
      if (file === undefined) {
        response.statusCode = 404;
        response.end();
        return;
      }
      const size = file.bytes.byteLength;
      let range: BuildResultFileRange | undefined;
      try {
        range = requestedByteRange(headers.range, size);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
        response.statusCode = 416;
        response.setHeader("content-range", `bytes */${size}`);
        response.end();
        return;
      }
      response.statusCode = range === undefined ? 200 : 206;
      response.setHeader("content-type", file.mediaType);
      response.setHeader("content-length", String(range === undefined ? size : range.endExclusive - range.start));
      response.setHeader("cache-control", "no-store");
      response.setHeader("accept-ranges", "bytes");
      if (range !== undefined) {
        response.setHeader("content-range", `bytes ${range.start}-${range.endExclusive - 1}/${size}`);
      }
      if (method === "HEAD") response.end();
      else response.end(range === undefined ? file.bytes : file.bytes.subarray(range.start, range.endExclusive));
      return;
    }

    if (path === "/artifact") {
      const build = url.searchParams.get("build");
      const output = url.searchParams.get("output");
      if (build === null || output === null || this.#buildLibrary === undefined) {
        response.statusCode = 404;
        response.end();
        return;
      }
      try {
        const artifact = await this.#buildLibrary.openArtifact(build, output);
        if (artifact === undefined) {
          response.statusCode = 404;
          response.end();
          return;
        }
        let range: BuildResultFileRange | undefined;
        try {
          range = requestedByteRange(headers.range, artifact.size);
        } catch (error) {
          if (!(error instanceof RangeError)) throw error;
          response.statusCode = 416;
          response.setHeader("content-range", `bytes */${artifact.size}`);
          response.end();
          return;
        }
        response.statusCode = range === undefined ? 200 : 206;
        response.setHeader("content-type", artifact.mediaType);
        response.setHeader("content-length", String(range === undefined
          ? artifact.size
          : range.endExclusive - range.start));
        response.setHeader("cache-control", "private, no-store");
        response.setHeader("accept-ranges", "bytes");
        if (range !== undefined) {
          response.setHeader("content-range", `bytes ${range.start}-${range.endExclusive - 1}/${artifact.size}`);
        }
        if (method === "HEAD") {
          response.end();
          return;
        }
        const stream = await artifact.open(range);
        if (stream === undefined) {
          response.statusCode = 404;
          response.removeHeader("content-length");
          response.removeHeader("content-range");
          response.end();
          return;
        }
        await pipeline(Readable.from(stream), response);
      } catch (error) {
        if (response.headersSent) response.destroy(error instanceof Error ? error : new Error(String(error)));
        else json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    response.statusCode = 404;
    response.end();
  }

  /** Tear down this session: close the build library and all watchers. */
  async close(): Promise<void> {
    for (const watcher of this.#watched.values()) {
      try { watcher.close(); } catch { /* ignore */ }
    }
    this.#watched.clear();
    this.#watchedFiles.clear();
    this.#storyboards.clear();
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    try {
      await this.#buildLibrary?.close();
    } catch (error) {
      // Build-library close failures are non-fatal at teardown.
    }
  }
}

/**
 * Phase 3 — workspace-id derivation.
 *
 * `base64url(absolutePath)` is deterministic, URL-safe (no `:` / `/` /
 * padding), and short enough to be ergonomic in URLs. Two distinct
 * absolute paths map to distinct ids because base64url is a bijection
 * over byte strings.
 */
export function workspaceIdFor(absolutePath: string): string {
  return Buffer.from(absolutePath, "utf8").toString("base64url");
}

/**
 * Phase 3 — what a workspace loader returns. One call per session on
 * first acquire; the same value is reused for every subsequent request
 * bound to that workspace.
 */
export type LoaderResult = {
  readonly domain: StudioDomain;
  readonly registry: StudioCompanionRegistry;
  readonly buildLibrary: StudioBuildLibrary | undefined;
};

/**
 * Phase 3 — pool of `WorkspaceSession`s keyed by workspace id.
 *
 * One instance per Studio process. `acquire()` lazy-creates a session on
 * first request and LRU-evicts the least-recently-used session when the
 * pool grows past `maxWorkspaces`. The first request for an unseen
 * workspace holds a single `Promise<WorkspaceSession>`; concurrent
 * callers for the same id wait on it, so the heavy
 * `loadStudioDomain + openStudioBuildLibrary + loadStudioRun` chain
 * runs once.
 *
 * `close()` is called from `studioPlugin.closeBundle` when the Vite
 * dev server shuts down. It tears down every session.
 */
export class WorkspaceRegistry {
  readonly #maxWorkspaces: number;
  readonly #sseHub: SseHub;
  readonly #authToken: string | undefined;
  readonly #pending = new Map<string, Promise<WorkspaceSession>>();
  readonly #sessions = new Map<string, WorkspaceSession>();

  constructor(options: { readonly maxWorkspaces: number; readonly sseHub: SseHub; readonly authToken: string | undefined }) {
    this.#maxWorkspaces = options.maxWorkspaces;
    this.#sseHub = options.sseHub;
    this.#authToken = options.authToken;
  }

  /**
   * Get-or-create the session for `workspaceId`. The caller is responsible
   * for having already computed the absolute workspace root and run path
   * (the registry doesn't know how to walk the filesystem to find them).
   *
   * The constructor + initial compile runs once; subsequent acquires
   * return the same `WorkspaceSession` with `lastUsed` bumped.
   */
  async acquire(opts: {
    readonly workspaceId: string;
    readonly workspaceRoot: string;
    readonly runPath: string;
    readonly packageRoot: string;
    readonly loader: () => Promise<LoaderResult>;
  }): Promise<WorkspaceSession> {
    const existing = this.#sessions.get(opts.workspaceId);
    if (existing !== undefined) {
      existing.touch();
      return existing;
    }
    let pending = this.#pending.get(opts.workspaceId);
    if (pending === undefined) {
      pending = this.#createSession(opts);
      this.#pending.set(opts.workspaceId, pending);
      try {
        const session = await pending;
        this.#sessions.set(opts.workspaceId, session);
        this.#evictIfOverCapacity();
        return session;
      } finally {
        this.#pending.delete(opts.workspaceId);
      }
    }
    const session = await pending;
    return session;
  }

  async #createSession(opts: {
    readonly workspaceId: string;
    readonly workspaceRoot: string;
    readonly runPath: string;
    readonly packageRoot: string;
    readonly loader: () => Promise<{
      readonly domain: StudioDomain;
      readonly registry: StudioCompanionRegistry;
      readonly buildLibrary: StudioBuildLibrary | undefined;
    }>;
  }): Promise<WorkspaceSession> {
    const loaded = await opts.loader();
    const session = new WorkspaceSession({
      workspaceId: opts.workspaceId,
      workspaceRoot: opts.workspaceRoot,
      runPath: opts.runPath,
      packageRoot: opts.packageRoot,
      domain: loaded.domain,
      registry: loaded.registry,
      buildLibrary: loaded.buildLibrary,
      sseHub: this.#sseHub,
      authToken: this.#authToken,
    });
    await session.initialCompile();
    return session;
  }

  /** Number of live sessions. */
  size(): number {
    return this.#sessions.size;
  }

  #evictIfOverCapacity(): void {
    while (this.#sessions.size > this.#maxWorkspaces) {
      let victim: WorkspaceSession | undefined;
      let victimId: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [id, session] of this.#sessions) {
        if (session.lastUsed < oldest) {
          oldest = session.lastUsed;
          victim = session;
          victimId = id;
        }
      }
      if (victim === undefined || victimId === undefined) break;
      this.#sessions.delete(victimId);
      void victim.close().catch(() => { /* swallow */ });
    }
  }

  async close(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    this.#pending.clear();
    await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
  }
}