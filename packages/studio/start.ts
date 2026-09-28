import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import type { CliIo } from "@hypit/cli";
import { parsePublicOrigins } from "./src/cors.js";
import type { PublicOrigins } from "./src/cors.js";
import { SseHub } from "./src/sse.js";
import { workspaceIdFor, WorkspaceRegistry } from "./src/workspace-registry.js";
import type { WorkspaceSpec } from "./src/server.js";
import type { LoaderResult } from "./src/workspace-registry.js";

const here = dirname(fileURLToPath(import.meta.url));

function describePublicOrigins(config: PublicOrigins): { readonly label: string } {
  if (config.mode === "none") return { label: "none (HYPIT_STUDIO_PUBLIC_ORIGINS unset)" };
  if (config.mode === "open") return { label: "*" };
  return { label: config.origins.join(", ") };
}

/**
 * Phase 2 — read `HYPIT_STUDIO_TOKEN` from the environment or generate a
 * fresh one. A generated token is printed once at startup so the operator
 * can hand it to embedders; it is not persisted anywhere.
 */
function resolveAuthToken(): { readonly token: string; readonly generated: boolean } {
  const configured = process.env.HYPIT_STUDIO_TOKEN?.trim();
  if (configured !== undefined && configured.length > 0) return { token: configured, generated: false };
  return { token: randomBytes(24).toString("base64url"), generated: true };
}

/**
 * Phase 3 — read the list of pre-registered workspaces.
 *
 * Two input shapes are supported:
 *
 *   HYPIT_STUDIO_WORKSPACES=/abs/a::runs/a.svrun,/abs/b::runs/b.svrun
 *
 * or, for the single-tenant back-compat case, the legacy `--run` +
 * `--workspace` CLI flags produce a one-element list.
 */
type WorkspaceInput = {
  readonly workspaceRoot: string;
  readonly runPath: string;
  readonly packageRoot: string;
};

function parseWorkspacesEnv(value: string | undefined): readonly WorkspaceInput[] | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.split(",").map((entry) => {
    const parts = entry.trim().split("::");
    if (parts.length !== 2 || parts[0]!.trim().length === 0 || parts[1]!.trim().length === 0) {
      throw new Error(`Malformed HYPIT_STUDIO_WORKSPACES entry ${JSON.stringify(entry)}; expected '<workspaceRoot>::<runPath>'.`);
    }
    return {
      workspaceRoot: resolve(parts[0]!.trim()),
      runPath: resolve(parts[0]!.trim(), parts[1]!.trim()),
      packageRoot: resolve(parts[0]!.trim()),
    };
  });
}

export function writeStudioHelp(io: Pick<CliIo, "write">): void {
  io.write(`hypit studio
Open a Run in the browser to inspect its composition, Sources and Results.

  hypit studio --run <build.svrun> [--runtime <hypit.runtime.json>]
    [--port <number>] [--workspace <directory>] [--package-root <directory>]
    [--locale-pack <./language.json | installed-package/language.json>]...

  hypit studio --check-locale <./language.json | installed-package/language.json>
    [--package-root <directory>]

Language packs are explicit JSON data. Relative files use the current directory;
package exports resolve from --package-root (the project by default).
--check-locale lists missing translations and unknown IDs without opening a Run.

Relative command-line paths start at the current directory; --workspace selects
the project, without rebasing those paths. Otherwise the nearest package.json
above the current directory defines the project (or the current directory if none).
Without --runtime, Studio uses that project's .hypit/runtime selection.
The server prints its project, Run, Runtime selection and browser URL.
Press Ctrl+C to stop it.

Multi-workspace mode (Phase 3):
  HYPIT_STUDIO_WORKSPACES=<rootA>::<runA>,<rootB>::<runB>  # pre-register workspaces
  HYPIT_STUDIO_DEFAULT_WORKSPACE=<root>                   # workspace for bare /__studio/* URLs
  HYPIT_STUDIO_MAX_WORKSPACES=8                          # LRU cap (default 8)

Network embedding:
  HYPIT_STUDIO_HOST=0.0.0.0          # bind address; default = localhost only
  HYPIT_STUDIO_PUBLIC_ORIGINS=...    # comma-separated origin whitelist or "*";
                                     # default unset = no cross-origin access
  HYPIT_STUDIO_TOKEN=...             # Bearer token authorising cross-origin writes;
                                     # default unset = auto-generated + printed once
  GET /__studio/<workspaceId>/<rest>  # workspace-bound endpoints (Phase 3)
  GET /__studio/events                # SSE bridge (snapshot / error / feedback-changed)
`);
}

function invalidArguments(message: string): never {
  throw new Error(`${message}. See hypit studio --help.`);
}

function argumentsByName(argv: readonly string[]): ReadonlyMap<string, readonly string[]> {
  const accepted = new Set(["run", "runtime", "port", "workspace", "package-root", "locale-pack", "check-locale"]);
  const result = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !flag.startsWith("--") || value === undefined || value.startsWith("--")) {
      invalidArguments(`Malformed argument near ${flag ?? "end of command"}`);
    }
    const name = flag.slice(2);
    if (!accepted.has(name)) invalidArguments(`Unknown option --${name}`);
    result.set(name, [...result.get(name) ?? [], value]);
  }
  return result;
}

export async function runStudio(argv: readonly string[], io: Pick<CliIo, "write">): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    writeStudioHelp(io);
    return;
  }
  const values = argumentsByName(argv[0] === "--" ? argv.slice(1) : argv);
  const invokedFrom = process.env.INIT_CWD ?? process.cwd();
  const runArgument = values.get("run")?.at(-1);

  const { findRuntimeProfile, resolveProjectRoot } = await import("@hypit/project-context-node");

  const packageRootArgument = values.get("package-root")?.at(-1);
  const workspaceArgument = values.get("workspace")?.at(-1);
  const { describeLanguagePack, loadLanguagePack, studioLanguages, studioLocalizationPlugin } = await import("./src/localization-node.js");
  const checkLocale = values.get("check-locale")?.at(-1);
  if (checkLocale !== undefined) {
    const packageRoot = packageRootArgument === undefined
      ? (workspaceArgument !== undefined ? resolve(invokedFrom, workspaceArgument) : process.cwd())
      : resolve(invokedFrom, packageRootArgument);
    io.write(describeLanguagePack(await loadLanguagePack(checkLocale, invokedFrom, packageRoot)) + "\n");
    return;
  }

  // ─── Workspace list (Phase 3) ─────────────────────────────────────────
  // Resolve the pre-registered workspaces. Priority:
  //   1. HYPIT_STUDIO_WORKSPACES env var (Phase 3 multi-tenant input)
  //   2. --run + (optional) --workspace / --package-root (single-tenant)
  let workspacesInput: readonly WorkspaceInput[];
  if (process.env.HYPIT_STUDIO_WORKSPACES !== undefined) {
    const parsed = parseWorkspacesEnv(process.env.HYPIT_STUDIO_WORKSPACES);
    if (parsed === undefined || parsed.length === 0) invalidArguments("HYPIT_STUDIO_WORKSPACES is empty.");
    workspacesInput = parsed;
  } else {
    if (runArgument === undefined || runArgument.trim().length === 0) {
      invalidArguments("Provide --run (single-tenant) or HYPIT_STUDIO_WORKSPACES (multi-tenant).");
    }
    const requestedWorkspaceRoot = workspaceArgument === undefined
      ? undefined
      : resolve(invokedFrom, workspaceArgument);
    const resolvedWorkspaceRoot = await resolveProjectRoot({
      ...(requestedWorkspaceRoot === undefined ? {} : { workspaceRoot: requestedWorkspaceRoot }),
      cwd: invokedFrom,
    });
    const resolvedPackageRoot = packageRootArgument === undefined
      ? resolvedWorkspaceRoot
      : resolve(invokedFrom, packageRootArgument);
    workspacesInput = [{
      workspaceRoot: resolvedWorkspaceRoot,
      runPath: resolve(invokedFrom, runArgument),
      packageRoot: resolvedPackageRoot,
    }];
  }

  // Build the registry.
  const bindHost = process.env.HYPIT_STUDIO_HOST;
  const publicOrigins = parsePublicOrigins(process.env.HYPIT_STUDIO_PUBLIC_ORIGINS);
  const auth = resolveAuthToken();
  const sseHub = new SseHub();
  const maxWorkspaces = Number(process.env.HYPIT_STUDIO_MAX_WORKSPACES ?? "8");
  if (!Number.isSafeInteger(maxWorkspaces) || maxWorkspaces < 1) {
    invalidArguments("--max-workspaces / HYPIT_STUDIO_MAX_WORKSPACES must be a positive integer");
  }
  const workspaceRegistry = new WorkspaceRegistry({ maxWorkspaces, sseHub, authToken: auth.token });

  // Compute workspaceIds.
  const workspaceSpecs: WorkspaceSpec[] = workspacesInput.map((input) => ({
    workspaceId: workspaceIdFor(input.workspaceRoot),
    workspaceRoot: input.workspaceRoot,
    runPath: input.runPath,
    packageRoot: input.packageRoot,
  }));
  const workspacesMap = new Map<string, WorkspaceSpec>(workspaceSpecs.map((spec) => [spec.workspaceId, spec]));

  // Default workspace: explicit env var, else first entry.
  let defaultWorkspaceId: string | undefined;
  const defaultEnv = process.env.HYPIT_STUDIO_DEFAULT_WORKSPACE?.trim();
  if (defaultEnv !== undefined && defaultEnv.length > 0) {
    const resolved = resolve(invokedFrom, defaultEnv);
    defaultWorkspaceId = workspaceIdFor(resolved);
    if (!workspacesMap.has(defaultWorkspaceId)) {
      // Allow the default to live outside the explicit list — register it.
      const inferred = workspacesInput[0]!;
      workspacesMap.set(defaultWorkspaceId, {
        workspaceId: defaultWorkspaceId,
        workspaceRoot: resolved,
        runPath: resolve(resolved, "runs/main.svrun"), // placeholder
        packageRoot: inferred.packageRoot,
      });
    }
  } else {
    defaultWorkspaceId = workspaceSpecs[0]?.workspaceId;
  }

  const languages = await studioLanguages(values.get("locale-pack") ?? [], invokedFrom, workspacesInput[0]!.packageRoot);

  // ─── Banner ──────────────────────────────────────────────────────────
  const hostInfo = bindHost === undefined || bindHost.trim() === ""
    ? { label: "localhost only (HYPIT_STUDIO_HOST unset)" }
    : { label: bindHost };
  const publicOriginsInfo = describePublicOrigins(publicOrigins);
  console.info([
    `  Project            ${workspacesInput[0]!.workspaceRoot}`,
    `  Workspaces         ${workspaceSpecs.length} registered (max ${maxWorkspaces}, LRU evicted)`,
    ...workspaceSpecs.map((spec) => `    ${spec.workspaceId}  ${spec.workspaceRoot}`),
    `  Default workspace  ${defaultWorkspaceId ?? "(none — bare /__studio/* URLs return 404)"}`,
    `  Bind host          ${hostInfo.label}`,
    `  Public origins     ${publicOriginsInfo.label}`,
    `  Write token        ${auth.token}${auth.generated ? "  (auto-generated for this session)" : ""}`,
    `  Embed SSE          GET /__studio/events  (snapshot / error / feedback-changed; events tagged with workspaceId)`,
    "",
  ].join("\n"));

  const port = Number(values.get("port")?.at(-1) ?? "5179");
  if (!Number.isSafeInteger(port) || port <= 0) invalidArguments("--port must be a positive integer");

  // ─── Compile workspace loader ────────────────────────────────────────
  const { openStudioBuildLibrary } = await import("./src/build-library.js");
  const { loadStudioCompanionRegistry } = await import("./src/companion-assembly.js");
  const { loadStudioDomain } = await import("./src/domain.js");
  const { loadStudioRun } = await import("./src/run.js");
  const { inspectStudioRun } = await import("./src/studio-preflight.js");
  const { videoCliDistribution, videoStudioCompanionPackages } = await import("@hypit/video-cli");
  const distributionPackageRoot = videoCliDistribution.packageRoot ?? resolve(here, "../..");

  type LoaderArgs = { readonly runPath: string; readonly workspaceRoot: string; readonly packageRoot: string };
  const compileLoader = async ({ runPath, workspaceRoot, packageRoot }: LoaderArgs): Promise<LoaderResult> => {
    const runtimeArgument = values.get("runtime")?.at(-1);
    const resolvedRuntimeProfile = runtimeArgument === undefined
      ? await findRuntimeProfile(workspaceRoot)
      : undefined;
    const resolvedRuntimePath = runtimeArgument === undefined
      ? resolvedRuntimeProfile?.profile
      : resolve(invokedFrom, runtimeArgument);
    const domain = await loadStudioDomain({ run: runPath, workspaceRoot, packageRoot });
    const registry = await loadStudioCompanionRegistry({
      distributionPackageRoot,
      distributionPackages: videoStudioCompanionPackages,
      sourcePackages: domain.packages,
    });
    const buildLibrary = await openStudioBuildLibrary(resolvedRuntimePath, packageRoot, workspaceRoot, distributionPackageRoot);
    let run;
    try {
      run = await loadStudioRun({ run: runPath, domain, registry, buildLibrary });
    } catch (error) {
      await buildLibrary.close();
      throw error;
    }
    try {
      inspectStudioRun(registry, run.source, run);
    } catch (error) {
      await buildLibrary.close();
      throw error;
    }
    return { domain, registry, buildLibrary };
  };

  const loader = (spec: WorkspaceSpec): Promise<LoaderResult> =>
    compileLoader({ runPath: spec.runPath, workspaceRoot: spec.workspaceRoot, packageRoot: spec.packageRoot });

  // Prewarm: compile every workspace up-front so the first request
  // doesn't pay the cold-start cost and the operator sees errors
  // before Vite starts listening.
  for (const spec of workspaceSpecs) {
    await workspaceRegistry.acquire({
      workspaceId: spec.workspaceId,
      workspaceRoot: spec.workspaceRoot,
      runPath: spec.runPath,
      packageRoot: spec.packageRoot,
      loader: () => loader(spec),
    });
  }

  // ─── Vite server ─────────────────────────────────────────────────────
  const { createServer } = await import("vite");
  const { resolveDistributionPackageImport } = await import("@hypit/package-loader-node");
  const { studioPlugin } = await import("./src/server.js");
  const { studioFeedbackPlugin } = await import("./src/feedback-server.js");

  const distributionImports = {
    name: "hypit-distribution-imports",
    enforce: "pre" as const,
    resolveId(specifier: string): string | undefined {
      return resolveDistributionPackageImport(distributionPackageRoot, specifier);
    },
  };

  const server = await createServer({
    configFile: false,
    root: here,
    server: {
      port,
      ...(bindHost === undefined || bindHost.trim() === "" ? {} : { host: bindHost.trim() }),
      // Vite resolves package assets through pnpm's real paths. The
      // package roots for every registered workspace must therefore be
      // readable; the author workspaces are separately available for
      // Source and material previews.
      fs: {
        allow: [
          ...workspacesInput.map((input) => input.workspaceRoot),
          ...workspacesInput.map((input) => input.packageRoot),
          distributionPackageRoot,
          here,
        ],
      },
    },
    plugins: [
      distributionImports,
      studioLocalizationPlugin(languages),
      studioFeedbackPlugin({
        workspaces: workspacesMap,
        defaultWorkspaceId,
        corsConfig: publicOrigins,
        authToken: auth.token,
        sseHub,
      }),
      studioPlugin({
        workspaceRegistry,
        sseHub,
        authToken: auth.token,
        corsConfig: publicOrigins,
        workspaces: workspacesMap,
        defaultWorkspaceId,
        loader,
      }),
    ],
  });

  server.httpServer?.once("close", () => {
    sseHub.close();
  });

  await server.listen();
  server.printUrls();
  for (const url of server.resolvedUrls?.local ?? []) {
    io.write(`  Comments (default)  ${url}#comments\n`);
  }
}