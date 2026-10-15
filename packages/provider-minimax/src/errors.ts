import { EndpointServiceError } from "@hypit/hypit/endpoint";
import { EndpointHttpError, retryAfterMs } from "@hypit/hypit/endpoint/http";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * A response may quote a short-lived signed asset URL. Keep the reason, never its
 * access capability: a Build log is copied into tickets and shared screenshots.
 */
export function safeMinimaxReason(value: string): string {
  return value.replace(/https?:\/\/\S+/giu, "[redacted-url]");
}

export class MinimaxServiceError extends EndpointServiceError {}

export class MinimaxHttpError extends EndpointHttpError {
  constructor(status: number, response: { readonly headers: Headers }, bodyText: string,
    request: { readonly method: string; readonly path: string; readonly model?: string }) {
    let body: Record<string, unknown> | undefined;
    try { body = record(JSON.parse(bodyText)); } catch { /* Non-JSON failures still carry HTTP evidence. */ }
    const reason = text(body?.error_msg) ?? text(body?.message)
      ?? (body === undefined ? text(bodyText.slice(0, 2000)) : undefined);
    const requestId = text(response.headers.get("x-request-id"));
    const facts = [
      `MiniMax HTTP ${status}`, `${request.method} ${request.path}`,
      ...(request.model === undefined ? [] : [`model=${request.model}`]),
      ...(requestId === undefined ? [] : [`request=${requestId}`]),
    ];
    super("MINIMAX_HTTP_ERROR", `${facts.join("; ")}${reason === undefined ? "" : `: ${safeMinimaxReason(reason)}`}`,
      status, retryAfterMs(response.headers));
  }
}

/**
 * MiniMax reports application failures inside a 200 response, under
 * `base_resp.status_code`; only `0` means success. A Provider that checks
 * `response.ok` alone would treat a rejected request as a successful one with no
 * images, which fails later and far from the cause.
 */
export function minimaxServiceFailure(response: Record<string, unknown>, model: string): MinimaxServiceError | undefined {
  const base = record(response.base_resp);
  if (base === undefined) return undefined;
  const status = base.status_code;
  if (status === undefined || Number(status) === 0) return undefined;
  const code = typeof status === "number" ? `MINIMAX_${status}` : "MINIMAX_ERROR";
  const reason = text(base.status_msg);
  return new MinimaxServiceError(code,
    `MiniMax ${model} rejected the request with status_code ${String(status)}${reason === undefined ? "" : `: ${safeMinimaxReason(reason)}`}`);
}