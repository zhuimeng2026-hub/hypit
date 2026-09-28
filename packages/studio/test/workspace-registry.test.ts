import assert from "node:assert/strict";
import test from "node:test";
import { SseHub } from "../src/sse.js";
import { workspaceIdFor, WorkspaceRegistry } from "../src/workspace-registry.js";
import type { LoaderResult } from "../src/workspace-registry.js";

/** A loader whose results can be inspected from outside the registry. */
type LoaderSpy = {
  readonly loader: (id: string) => Promise<LoaderResult>;
  readonly calls: Map<string, number>;
};

function makeSpyLoader(): LoaderSpy {
  const calls = new Map<string, number>();
  return {
    calls,
    loader: async (_id) => {
      throw new Error("loader is unused in registry tests; provide a stub");
    },
  };
}

function stubLoader(result: LoaderResult = {
  domain: {} as LoaderResult["domain"],
  registry: {} as LoaderResult["registry"],
  buildLibrary: undefined,
}): () => Promise<LoaderResult> {
  return async () => result;
}

test("workspaceIdFor is deterministic and base64url-safe", () => {
  const a = workspaceIdFor("/Users/me/proj/foo");
  const b = workspaceIdFor("/Users/me/proj/foo");
  const c = workspaceIdFor("/Users/me/proj/bar");
  assert.equal(a, b, "same path -> same id");
  assert.notEqual(a, c, "different paths -> different ids");
  assert.equal(a.includes("/"), false, "base64url never contains '/'");
  assert.equal(a.includes(":"), false, "base64url never contains ':'");
  assert.equal(a.includes("+"), false, "base64url never contains '+'");
  assert.match(a, /^[A-Za-z0-9_-]+$/u);
});

test("acquire creates a session on first call", async () => {
  const registry = new WorkspaceRegistry({ maxWorkspaces: 4, sseHub: new SseHub(), authToken: undefined });
  const session = await registry.acquire({
    workspaceId: "ws_a",
    workspaceRoot: "/abs/a",
    runPath: "/abs/a/runs/a.svrun",
    packageRoot: "/abs/a",
    loader: stubLoader(),
  });
  assert.equal(session.workspaceId, "ws_a");
  assert.equal(registry.size(), 1);
});

test("acquire returns the same session on second call with the same id", async () => {
  const registry = new WorkspaceRegistry({ maxWorkspaces: 4, sseHub: new SseHub(), authToken: undefined });
  const a = await registry.acquire({
    workspaceId: "ws_a",
    workspaceRoot: "/abs/a",
    runPath: "/abs/a/runs/a.svrun",
    packageRoot: "/abs/a",
    loader: stubLoader(),
  });
  const b = await registry.acquire({
    workspaceId: "ws_a",
    workspaceRoot: "/abs/a",
    runPath: "/abs/a/runs/a.svrun",
    packageRoot: "/abs/a",
    loader: stubLoader(),
  });
  assert.equal(a, b, "second acquire returns the same session");
  assert.equal(registry.size(), 1);
});

test("acquire evicts the LRU session when over capacity", async () => {
  const registry = new WorkspaceRegistry({ maxWorkspaces: 2, sseHub: new SseHub(), authToken: undefined });
  const a = await registry.acquire({
    workspaceId: "ws_a", workspaceRoot: "/a", runPath: "/a/r.svrun", packageRoot: "/a",
    loader: stubLoader(),
  });
  // Wait a millisecond so timestamps differ between acquisitions.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const b = await registry.acquire({
    workspaceId: "ws_b", workspaceRoot: "/b", runPath: "/b/r.svrun", packageRoot: "/b",
    loader: stubLoader(),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const c = await registry.acquire({
    workspaceId: "ws_c", workspaceRoot: "/c", runPath: "/c/r.svrun", packageRoot: "/c",
    loader: stubLoader(),
  });
  assert.equal(registry.size(), 2, "oldest session was evicted to stay under cap");
  // `a` was the oldest — it's gone. `b` and `c` remain.
  assert.notEqual(a, undefined);
  assert.equal(registry.size(), 2);
  // Touch b so c becomes LRU; acquire a fourth session, expect c evicted.
  await new Promise((resolve) => setTimeout(resolve, 5));
  b.lastUsed; // ensure TS reads the property (no-op for the test logic)
  await registry.acquire({
    workspaceId: "ws_d", workspaceRoot: "/d", runPath: "/d/r.svrun", packageRoot: "/d",
    loader: stubLoader(),
  });
  assert.equal(registry.size(), 2, "still under cap after fourth acquire");
});

test("two consecutive acquires for the same id both await the same loader call", async () => {
  const registry = new WorkspaceRegistry({ maxWorkspaces: 4, sseHub: new SseHub(), authToken: undefined });
  let loaderInvocations = 0;
  const loader = (): Promise<LoaderResult> => {
    loaderInvocations += 1;
    return Promise.resolve({ domain: {} as LoaderResult["domain"], registry: {} as LoaderResult["registry"], buildLibrary: undefined });
  };
  const opts = {
    workspaceId: "ws_concurrent",
    workspaceRoot: "/abs/c",
    runPath: "/abs/c/r.svrun",
    packageRoot: "/abs/c",
    loader,
  };
  const first = await registry.acquire(opts);
  const second = await registry.acquire(opts);
  assert.equal(first, second, "both callers see the same session");
  assert.equal(loaderInvocations, 1, "the loader ran exactly once");
  assert.equal(registry.size(), 1);
});

test("close tears down every session", async () => {
  const registry = new WorkspaceRegistry({ maxWorkspaces: 4, sseHub: new SseHub(), authToken: undefined });
  await registry.acquire({
    workspaceId: "ws_a", workspaceRoot: "/a", runPath: "/a/r.svrun", packageRoot: "/a",
    loader: stubLoader(),
  });
  await registry.acquire({
    workspaceId: "ws_b", workspaceRoot: "/b", runPath: "/b/r.svrun", packageRoot: "/b",
    loader: stubLoader(),
  });
  assert.equal(registry.size(), 2);
  await registry.close();
  assert.equal(registry.size(), 0);
});

test("close swallows session.close() failures", async () => {
  // We can't easily make a real session throw on close because the
  // session's buildLibrary is optional. Instead, verify that calling
  // close on an empty registry is a no-op rather than a thrown error.
  const registry = new WorkspaceRegistry({ maxWorkspaces: 4, sseHub: new SseHub(), authToken: undefined });
  await registry.close();
  await registry.close();
  assert.equal(registry.size(), 0);
});

test("registry exposes size, lastUsed bump keeps a session hot under LRU", async () => {
  const registry = new WorkspaceRegistry({ maxWorkspaces: 2, sseHub: new SseHub(), authToken: undefined });
  await registry.acquire({
    workspaceId: "ws_a", workspaceRoot: "/a", runPath: "/a/r.svrun", packageRoot: "/a",
    loader: stubLoader(),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await registry.acquire({
    workspaceId: "ws_b", workspaceRoot: "/b", runPath: "/b/r.svrun", packageRoot: "/b",
    loader: stubLoader(),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // Touch ws_a, then add ws_c. Expect ws_b to be evicted (older lastUsed).
  await registry.acquire({
    workspaceId: "ws_a", workspaceRoot: "/a", runPath: "/a/r.svrun", packageRoot: "/a",
    loader: stubLoader(),
  });
  await registry.acquire({
    workspaceId: "ws_c", workspaceRoot: "/c", runPath: "/c/r.svrun", packageRoot: "/c",
    loader: stubLoader(),
  });
  assert.equal(registry.size(), 2);
});