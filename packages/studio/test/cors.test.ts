import assert from "node:assert/strict";
import type { IncomingHttpHeaders } from "node:http";
import test from "node:test";
import { allowedOriginHeader, corsHeaders, frameAncestors, parsePublicOrigins, studioCorsMiddleware } from "../src/cors.js";

test("parsePublicOrigins treats unset / blank / star distinctly", () => {
  assert.deepEqual(parsePublicOrigins(undefined), { mode: "none" });
  assert.deepEqual(parsePublicOrigins(""), { mode: "none" });
  assert.deepEqual(parsePublicOrigins("   "), { mode: "none" });
  assert.deepEqual(parsePublicOrigins("*"), { mode: "open" });
  assert.deepEqual(parsePublicOrigins("https://a.test,https://b.test"), {
    mode: "list",
    origins: ["https://a.test", "https://b.test"],
  });
  assert.deepEqual(parsePublicOrigins(" https://a.test , https://b.test "), {
    mode: "list",
    origins: ["https://a.test", "https://b.test"],
  });
  assert.deepEqual(parsePublicOrigins(",,,"), { mode: "none" });
});

test("corsHeaders is empty when public origins are not configured", () => {
  const config = { mode: "none" } as const;
  assert.deepEqual(corsHeaders("https://anywhere.test", config), {});
  assert.deepEqual(corsHeaders(undefined, config), {});
});

test("corsHeaders uses '*' when open and reflects matching origins when whitelisted", () => {
  assert.deepEqual(corsHeaders("https://anywhere.test", { mode: "open" }), {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "content-type, range",
    "access-control-max-age": "86400",
    "vary": "Origin",
  });
  const whitelist = { mode: "list", origins: ["https://a.test", "https://b.test"] } as const;
  assert.deepEqual(corsHeaders("https://a.test", whitelist)["access-control-allow-origin"], "https://a.test");
  assert.deepEqual(corsHeaders("https://b.test", whitelist)["access-control-allow-origin"], "https://b.test");
  assert.deepEqual(corsHeaders("https://other.test", whitelist), {});
  // No Origin header (curl, same-origin fetch) means no CORS header is needed.
  assert.deepEqual(corsHeaders(undefined, whitelist), {});
});

test("frameAncestors reflects the configured mode", () => {
  assert.equal(frameAncestors({ mode: "none" }), undefined);
  assert.equal(frameAncestors({ mode: "open" }), "frame-ancestors *");
  assert.equal(
    frameAncestors({ mode: "list", origins: ["https://a.test", "https://b.test"] }),
    "frame-ancestors https://a.test https://b.test",
  );
});

test("allowedOriginHeader tracks the same rule as corsHeaders' allow-origin", () => {
  assert.equal(allowedOriginHeader("https://a.test", { mode: "none" }), undefined);
  assert.equal(allowedOriginHeader("https://a.test", { mode: "open" }), "*");
  const whitelist = { mode: "list", origins: ["https://a.test"] } as const;
  assert.equal(allowedOriginHeader("https://a.test", whitelist), "https://a.test");
  assert.equal(allowedOriginHeader("https://other.test", whitelist), undefined);
});

type ResponseStub = {
  headers: Record<string, string>;
  statusCode: number;
  ended: boolean;
  setHeader(name: string, value: string): void;
  end(chunk?: unknown): void;
};

function captureResponse(): ResponseStub {
  const response: ResponseStub = {
    headers: {},
    statusCode: 0,
    ended: false,
    setHeader(name, value) { response.headers[name.toLowerCase()] = value; },
    end() { response.ended = true; },
  };
  return response;
}

test("studioCorsMiddleware short-circuits OPTIONS preflight with 204 + CORS headers", () => {
  const middleware = studioCorsMiddleware({ mode: "open" });
  const response = captureResponse();
  let nextCalled = false;
  middleware(
    { url: "/__studio/visual.html", method: "OPTIONS", headers: { origin: "https://a.test" } as IncomingHttpHeaders },
    response,
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, false, "preflight answers immediately without calling next()");
  assert.equal(response.statusCode, 204);
  assert.equal(response.ended, true);
  assert.equal(response.headers["access-control-allow-origin"], "*");
  assert.equal(response.headers["access-control-allow-methods"], "GET, HEAD, OPTIONS");
});

test("studioCorsMiddleware decorates non-OPTIONS /__studio/* and forwards to next", () => {
  const middleware = studioCorsMiddleware({ mode: "list", origins: ["https://a.test"] });
  const response = captureResponse();
  let nextCalled = false;
  middleware(
    { url: "/__studio/visual.html", method: "GET", headers: { origin: "https://a.test" } as IncomingHttpHeaders },
    response,
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
  assert.equal(response.ended, false, "middleware must not consume the response");
  assert.equal(response.headers["access-control-allow-origin"], "https://a.test");
});

test("studioCorsMiddleware ignores requests outside /__studio/*", () => {
  const middleware = studioCorsMiddleware({ mode: "open" });
  const response = captureResponse();
  let nextCalled = false;
  middleware(
    { url: "/index.html", method: "GET", headers: { origin: "https://a.test" } as IncomingHttpHeaders },
    response,
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
  assert.equal(Object.keys(response.headers).length, 0);
});

test("studioCorsMiddleware omits CORS headers when whitelist does not match", () => {
  const middleware = studioCorsMiddleware({ mode: "list", origins: ["https://a.test"] });
  const response = captureResponse();
  let nextCalled = false;
  middleware(
    { url: "/__studio/session", method: "GET", headers: { origin: "https://other.test" } as IncomingHttpHeaders },
    response,
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
  assert.equal(Object.keys(response.headers).length, 0);
});