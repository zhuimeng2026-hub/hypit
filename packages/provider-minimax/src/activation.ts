import {
  createRuntimeEndpointAdapterFacet,
  runtimeConfigCredentialRef,
  runtimeConfigActionLimits,
  runtimeConfigExact,
  runtimeConfigObject,
  runtimeConfigPositiveInteger,
  runtimeConfigString,
} from "@hypit/runtime-local/extension";

import { createMinimaxProvider } from "./provider.js";
import { minimaxDefaultModels } from "./routes.js";

const adapter = createRuntimeEndpointAdapterFacet({
  use: "@hypit/provider-minimax",
  activate(context) {
    if (context.pool === undefined) throw new Error("MiniMax Provider Pool is required");
    const config = runtimeConfigObject(context.config, "MiniMax");
    runtimeConfigExact(config, [
      "baseUrl",
      "apiKey",
      "models",
      "defaultConcurrency",
      "actionLimits",
      "requestTimeoutMs",
      "pollIntervalMs",
      "operationTimeoutMs",
    ], "MiniMax");
    const baseUrl = runtimeConfigString(config.baseUrl, "MiniMax baseUrl");
    if (baseUrl !== undefined) {
      const url = new URL(baseUrl);
      // A gateway may be plain HTTP on loopback; anything else must be HTTPS.
      if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        throw new Error("MiniMax baseUrl must use HTTPS or loopback");
      }
    }
    const apiKey = runtimeConfigCredentialRef(config.apiKey, "MiniMax apiKey");
    if (apiKey === undefined) throw new Error("MiniMax apiKey CredentialRef is required");

    // `models` rewrites only the wire model names, so a deployment can address a
    // gateway's aliases while keeping every other mapping untouched.
    let models: Readonly<Record<string, string>> | undefined;
    if (config.models !== undefined) {
      const supplied = runtimeConfigObject(config.models, "MiniMax models");
      models = Object.fromEntries(Object.entries(supplied).map(([key, value]) => {
        if (typeof value !== "string" || value.trim().length === 0) {
          throw new Error(`MiniMax models.${key} must be a non-empty model name`);
        }
        if (minimaxDefaultModels[key] === undefined) {
          throw new Error(`MiniMax models.${key} names no capability this Provider serves`);
        }
        return [key, value];
      }));
    }

    const actionLimits = runtimeConfigActionLimits(config.actionLimits);
    const defaultConcurrency = runtimeConfigPositiveInteger(config.defaultConcurrency, "MiniMax defaultConcurrency");
    const requestTimeoutMs = runtimeConfigPositiveInteger(config.requestTimeoutMs, "MiniMax requestTimeoutMs");
    const pollIntervalMs = runtimeConfigPositiveInteger(config.pollIntervalMs, "MiniMax pollIntervalMs");
    const operationTimeoutMs = runtimeConfigPositiveInteger(config.operationTimeoutMs, "MiniMax operationTimeoutMs");
    return {
      endpoint: createMinimaxProvider({
        instance: context.instance,
        pool: context.pool,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        apiKey,
        ...(models === undefined ? {} : { models }),
        ...(defaultConcurrency === undefined ? {} : { defaultConcurrency }),
        ...(actionLimits === undefined ? {} : { actionLimits }),
        ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
        ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
        ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }),
      }),
    };
  },
});

export const hypitPackage = {
  format: "hypit.package@1" as const,
  facets: [adapter],
};

export default hypitPackage;