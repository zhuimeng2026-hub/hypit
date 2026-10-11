# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`hypit` is the `@hypit/hypit` npm Distribution — an open-source video authoring system for AI coding
agents (Claude Code, Codex, etc.). It supplies the executable, official components, Model and Provider
packages and Skills that let an agent turn a reference video or a brief into an editable, re-runnable
video project (`.svml`/`.svs`/`.svrun` source, rendered via headless Chromium).

Real video projects live **outside** this repo as their own npm/pnpm-managed projects; this checkout
contains the SDK packages, the `hypit` CLI, official components/models/providers, Python services,
runnable examples and the production-directing Skill.

The Skill is the primary agent entry point. Install it once with:

```bash
npx skills add hypit-ai/hypit -g
```

The Skill, the npm Distribution and a saved video project update independently.

## Tooling requirements

- Node.js **22.15+** (`.node-version` pins 24.14.1)
- pnpm **10.33** (selected by the root `packageManager` field — enable with `corepack enable`)
- Python 3.10–3.13 + `uv` only for live local Builds (WhisperX / OpenCV services)
- ffmpeg/ffprobe and a Chromium downloaded by `hypit runtime up` for local HTML rendering

Node and pnpm are the only hard requirements; everything else is needed only for live Builds.

## Common commands

```bash
corepack enable
pnpm install --frozen-lockfile        # workspace setup (CI command)

pnpm check                            # tsc --noEmit over the whole workspace
pnpm test                             # full suite via test/run.mjs (node:test, 120s per-test timeout)
pnpm hypit -- <args>                  # run the CLI directly
pnpm studio                           # launch Studio

pnpm test:runtime-scale               # env-gated: HYPIT_RUNTIME_SCALE_TESTS=1
pnpm test:image-opencv                # env-gated: needs the Provider's uv interpreter
pnpm test:whisperx-service            # Python unittests under packages/provider-whisperx-local

# One test file, bypassing the suite gate:
node --import tsx --test packages/<pkg>/test/<file>.test.ts

# Local browser rendering (Chrome/ffmpeg required):
HYPIT_BROWSER_TESTS=1 node --import tsx --test packages/provider-html-local/test/provider.test.ts

pnpm docs:dev / docs:build            # VitePress site
```

**Packaging scripts must be invoked through npm, not pnpm.** They assert
`process.env.npm_execpath` ends in `npm-cli.js` and fail otherwise:

```bash
npm run pack:distribution            # build dist/public/**/*.d.ts + dist/release/hypit-hypit-<v>.tgz
npm run pack:release-candidate       # every independent package + the Distribution + release-plan.json
npm run check:release-candidate      # verify the plan's tarball closure, then check:distribution
npm run check:distribution <tarball> # install + exercise the tarball outside this checkout
npm run pack:independent -- packages/<name>
```

The nine `npm run check:*-package` scripts (`check:author-packages`, `check:component-packages`,
`check:hypihub-package`, `check:ranking-package`, `check:runtime-packages`, `check:seedance-package`,
`check:visual-track-package`, `check:audio-track-package`, `check:fine-packages`) each verify one
invariant: **an independently versioned package is genuinely installable and consumable outside the
repo**. They pack the package, `npm install` it into a scratch consumer, and assert on the *installed*
manifest (`private` removed, `exports` rewritten `.ts`→`.dist/.js`, `hypit.activation` rewritten,
`devDependencies` stripped, `workspace:`→caret ranges, no `src/*.ts`, `LICENSE` present). **These are
not wired into CI** — `ci.yml` runs only `pnpm check` and `pnpm test`.

Before the first local render: `hypit runtime up --runtime <profile>` (prepares programs + starts the
Worker) or `hypit programs up --runtime <profile> --endpoint <render-instance>`. `hypit doctor`
diagnoses missing setup without installing anything.

## `ls packages/` lies — this is the single biggest trap

Commit `db4e545d` ("refactor: rebuild the domain-neutral language host", 2026-10-07) renamed and
removed ~30 packages. **The working tree still contains 67 empty directories that hold nothing but a
stale `node_modules/`**: `core`, `compiler-node`, `compiler-markup-node`, `elaborator`, `validation`,
`artifact`, `file-io-node`, `driver-node`, `author-kit`, `component-kit`, `model-kit`,
`endpoint-kit`, `runtime-kit`, `build-result*`, `resource-store-*`, `store-sqlite`,
`workspace-fs-node`, `package-loader-node`, `runtime-host-node`, `hyperframes`, `render-hyperframes`,
`provider-hyperframes-local`, `provider-media-local`, `raster`, `fonts-open`,
`credential-store-file`, `credential-store-os`, `credential-store-platform`, `temporal-markup`,
`transport-aws-lambda`, `studio-adapter`, `video-cli`, `visual-ir`, `speech`,
`speech-alignment`, `sound`, `performance`, `program-space`, `media-execution`, `media-pipeline`,
`media-track*`, `deck-track*`, `typography-track*`, `screen-overlay*`, `*-studio`, `semantic-take-adjust`,
`image-compose`, `image-transform`, `background-removal`, `svs`, `estimate`, `run-markup`.

`host` is the one name in this family that is *gone entirely* rather than empty — its files moved to
`facet`, and the directory was removed. An empty dir has a stale `node_modules/`; a missing dir has
nothing at all, and both will fool a glob.

`ls packages/` shows **152 directories; only 85 are real.** Always confirm with:

```bash
git ls-tree HEAD --name-only packages/     # authoritative
git ls-files packages/<name>               # is this package real?
```

Rename map from that commit (useful when reading older docs, issues or git history):

| Old | New |
|---|---|
| `validation` | `admission` |
| `compiler-node` | `compiler` |
| `elaborator` | `author` (its `source.ts` folded into `compiler`) |
| `driver-node` | `executor` |
| `host` | `facet` (now a zero-dep leaf, was the runtime layer) |
| `artifact` | `blob` |
| `file-io-node` | `atomic-file` |
| `author-kit` / `model-kit` / `endpoint-kit` / `component-kit` | deleted — roles moved into the `@hypit/hypit/*` public subpaths |
| `run-markup`, `compiler-markup-node` | `@hypit/markup/run` subpath export |
| `svs` | `recipe` |
| `media-track` | `visual-track` (`Item` → `Clip`) |
| `program-space` | merged into `timeline-author` (`program:Clock` → `time:Clock`) |
| `render-hyperframes` | `html-video` (`render:Video` → `html:Video`) |
| `hyperframes` | `html-program` |
| `provider-hyperframes-local` | `provider-html-local` |
| `build-result*` / `resource-store-*` | `result` / `result/node` |
| `speech`, `speech-alignment` | `speech-estimate`, `narrative-speech-alignment` |
| `whisperx:SemanticTake`, `time:Take` | deleted outright (not renamed) |

`docs/guide/renderer-choice.md` is also stale for the same reason — it cites
`packages/hyperframes/src/document.ts` and `packages/provider-hyperframes-local/src/capture.ts`. The
same contracts now live at `packages/html-program/src/document.ts:752` and
`packages/html-program/src/text.ts:1186` / `packages/provider-html-local/src/capture.ts`. The four
C-category render blockers it describes (the per-seek `waitUntil` barrier, paused-CSS seek-and-cancel,
the `VisualProgram` escape hatch, source-frame video slot injection) are all still real.

The vocabulary drifted further than the paths did, so following the old file paths is not enough — read
the current names off the code instead:

| `renderer-choice.md` says | Actually now |
|---|---|
| `hf-seek` event (5 mentions) | `hypit-frame` — dispatched in-page by `frameProgramRuntime` (`html-program/src/document.ts:750`), not by the Renderer over CDP |
| `packages/hyperframes/src/browser-program.ts` | `packages/html-program/src/html-visual.ts`; the `(root, data) => render(localFrame)` escape hatch is enforced there |
| Renderer "dispatches `hf-seek`, awaits `detail.waitUntil`" | The page owns the loop. It exposes `window.__hypitFrameProgram.{prepare,applyFrame}` (`document.ts:755-760`); `capture.ts:205` calls `prepare()` once and `applyFrame` per frame. `waitUntil` is still the per-frame barrier contract — `applyFrame` dispatches, `await Promise.all(pending)`, then forces layout. |

So the *contract* CLAUDE.md and your memory record (per-seek `waitUntil` barrier) is intact; only the
event name and the dispatch direction changed. Treat the four blockers as real, and grep for
`hypit-frame`, not `hf-seek`.

## Repository layout

```
hypit/
├── bin/hypit.mjs              CLI entrypoint (tsx register + Distribution resolution + command table)
├── packages/                  85 real workspace packages (see Architecture)
├── services/whisperx/         Python service (source of truth for the WhisperX runtime)
├── examples/                  runnable end-to-end projects + the two canonical package templates
├── skills/hypit/              Production-directing Skill for AI agents (git-distributed, not npm)
├── skills/url-to-video/       Narrower URL→video orchestrator Skill that defers to `hypit`
├── utils/                     LAN mirror stack (Verdaccio, nginx proxies, read-only git mirror)
├── tools/dub-server/          Video-dubbing pipeline, as MCP + CLI (see CLAUDE.local.md)
├── docs/                      VitePress site (English + docs/zh/ Chinese mirror)
├── test/                      Shared fixtures + one boundary test + the suite runner
├── scripts/                   pack-distribution, check-distribution, release-candidate, ownership
└── pnpm-workspace.yaml        globs: packages/*, services/*, examples/*/packages/*
```

`docs/guide/` is the maintained prose documentation and is current where the root CLAUDE.md used to
be. Read `docs/guide/develop.md`, `packages.md`, `runtime.md`, `conventions.md`, `testing.md`,
`component-anatomy.md`, `author-packages.md`, `providers.md` rather than re-deriving the model.
`docs/` and `docs/zh/` are side-by-side twins — a change to one belongs with the change to its
counterpart, in the same commit.

### Examples

`examples/*/packages/*/test/**/*.test.ts` is part of the default suite, because project-package
behavior is ordinary authoring. Two examples are canonical templates for new packages:

- `examples/minimal-author-package/` — new Author component template (see `docs/guide/author-packages.md`)
- `examples/provider-package/` — new Provider template (see `docs/guide/providers.md`)

The rest (`interview/`, `podcast/`, `ranking-football/`, `complex-explainer/`, `guangzhou-clone/`,
`guizou-clone/`, `semantic-composition/`, `gz-exbi-en/`) are runnable reference projects with their own
`.svml`/`.svs`/`.svrun` and `hypit.runtime.json`.

## Source formats

The extensions are unchanged by the refactor: **27 `.svml`, 29 `.svs`, 32 `.svrun`** across `examples/`.
What changed is the grammar. Every file starts with a self-describing Source Header — the *only*
bootstrap, parsed by `packages/source/src/header.ts`:

```
[optional UTF-8 BOM] <?svml using="@hypit/<frontend>@1"?>
```

There are deliberately **no comments, aliases, interpolation or defaults**, and the Frontend is never
guessed. Roles:

| File | Frontend | Root element | Role |
|---|---|---|---|
| `.svml` | `@hypit/markup@1` | `<svml>` | Author Source: timeline, semantic anchors, placed media, script |
| `.svs` | `@hypit/recipe@1` | `<sheet version="1">` | Style recipes: `{ path { prop: value } }` blocks |
| `.svrun` | `@hypit/markup/run@1` | `<svrun version="1">` | Run: targets, candidates, reuse selections, overrides |

A `.svml` imports logical Module addresses (`<import as="time" from="@hypit/timeline-author@1"/>`) and
references a `.svs` by path (`<import as="style" source="./chat.svs"/>`). See
`examples/semantic-composition/chat.{svml,svs,svrun}` for a small, current, post-refactor example.

## Architecture

Three owners: **Project** (authored sources, package deps, selected Runtime Profile), **Distribution**
(the installed executable + public SDKs — this repo), **Runtime Profile** (selected Provider Endpoints,
credential refs, bindings). One Build is one execution attempt producing a `BuildResult` in a
configured Result repository.

### Package layering

Derived from package manifests; nothing enforces it (there is no layering or circular-dependency test
in `test/`, and `docs/guide/testing.md` explicitly rejects source-text regex tests as a substitute for
dependency analysis):

```
L0  protocol · facet · project · atomic-file       (no @hypit deps)
L1  kernel · source · blob · result · loader       (→ protocol)
L2  runtime · workspace · endpoint                 (→ kernel/protocol/source)
L3  author · admission · producer                  (→ kernel/facet/protocol/source)
L4  run · markup · compiler · executor             (→ L2 + L3)
L5  cli                                            (→ everything; depends on 16 internal packages)
```

Two contracts carry most of the design weight:

- **`facet`** is the entire plugin envelope: an opaque `{ abi, offers?, implementation }` bag, "understood
  only by the owner of its exact ABI". Package loading **never interprets** a Facet — each consumer
  filters by exact ABI string (`hypit.producer-package@1`, `hypit.admission-package@1`,
  `hypit.markup-surface@1`, `hypit.exact-model@1`, `hypit.studio-companion@1`,
  `hypit.runtime-local-endpoint-adapter@1`, `hypit.source-frontend@1`, `hypit.cli-command@1`).
- **`producer`**: `ProducerHandlerContext` is a *pure* compute context — "artifact bytes, credentials,
  network and stores are deliberately absent; those effects must cross an explicit Need into a
  Provider." This is why Providers own bounded transport retries and all I/O.

### The three kinds of package

Distinguished by which facet ABIs the activation entry emits **and** which axis selects them.

| Kind | Selected by | Built with | Examples |
|---|---|---|---|
| **Author component** | Source import (`<import from="..."/>`) | `createProducerPackageFacet` + `createAdmissionPackageFacet` + `createMarkupSurfaceFacet` | `ranking`, `film`, `caption-fine`, `visual-track`, `audio-track`, `script`, `text-fine`, `comment-sticker`, `depth-stack`, `minimal-author-package` |
| **Model** | Source import | `defineExactModelModule` from `@hypit/generation/model` (emits `hypit.exact-model@1`) | `seedance`, `gpt-image`, `nano-banana`, `grok-imagine`, `pixverse`, `wan`, `seedream`, `minimax-h3` |
| **Provider** | Runtime Profile `endpoints` + `bindings` | `defineEndpoint` + `createRuntimeEndpointAdapterFacet` from `@hypit/runtime-local/extension` | `provider-hypihub`, `provider-html-local`, `provider-whisperx-local`, `provider-image-opencv-local`, `media-local`, and the `provider-beatapi/hiapi/monid/pollo/tokendance` family |

A Provider declares its own narrower support via `supports`; the Model owns request meaning and the
Provider owns service mapping and pricing. A failed service request never silently selects another
account.

### Package activation

`package.json` → `hypit.activation` (package-relative, must not escape). The loader imports it and
requires `format === "hypit.package@1"` on the **default export**, then transitively resolves every
`manifest.dependencies` Module. `verifyPackageContributions` rejects duplicate Module
`name@version`, duplicate module specifiers and empty/duplicate facet offers — "validates declarations
and logical offers without interpreting any executable Facet."

There is no global plugin registry and no auto-discovery: a contribution is inert until some consumer
routes it by ABI. `packages/cli/src/application.ts` is explicit that "project packages never acquire
CLI authority merely by being installed or imported."

### Studio companion

The old `foo` + `foo-studio` package pairs are **gone**. A component is one package with two export
subpaths — `"."` → `src/index.ts` and `"./studio"` → `src/studio.ts` — and the Studio contribution is
an extra facet in the same `activation.ts`:

```ts
import { createStudioTrackCompanionFacet } from "@hypit/studio-companion";
// or createStudioCompanionFacet({ tracks, parameters })
```

Packages with a `./studio` export: `audio-track`, `caption-fine`, `comment-sticker`, `depth-stack`,
`film`, `ranking`, `script`, `temporal`, `text-fine`, `visual-track`. Packages depending on
`@hypit/studio-companion`: those ten plus `timeline-author`, `fontsource` and `studio` itself.

### CLI composition

There is **one** CLI package: `packages/cli` (private). `bin/hypit.mjs` `realpath`s the Distribution
root (Windows short-path guard), registers `tsx`, installs Distribution package resolution so
`@hypit/hypit/*` resolves to this checkout's TS sources, then builds one flat command table from the
`hypit.cli.use` arrays of two manifests:

- **Distribution** (root `package.json`): `@hypit/runtime-local/cli`, `@hypit/browser-capture/cli`,
  `@hypit/yt-dlp/cli`, `@hypit/media-local/cli`, `@hypit/speech-estimate/cli`, `@hypit/whisperx/cli`,
  `@hypit/video/cli`, `@hypit/studio/cli`
- **Project** (the video project's own `package.json`), additionally gated by `requireDirectDependency`

Each specifier must export a non-empty `cliCommandModules` array of `hypit.cli-command@1` objects.
`indexCliCommandModules` enforces **one owner per root command** and reserves `help` plus
`genericCliCommandNames`. `@hypit/video` owns only `vocabulary` and supplies `createVideoDistribution`
(the default Profile: `hypihub.default`, `media.local`, `html.local`, `image.opencv.local`); `@hypit/studio`
owns `studio` and `snapshot`. Manage with `hypit cli status|use|remove`, which only edits
`package.json`.

Commands owned by `packages/cli` itself: `version`, `cli`, `check`, `plan`, `pricing`, `build`,
`builds`, `history`, `inspect`, `get`, `result`, `logs`, `status`, `activity`, `cancel`, `auth`,
`doctor`.

### Runtime execution

`hypit.runtime.json` (`format: "hypit.runtime-local@1"`) declares `dataRoot`, `credentials` (a store
name), `endpoints` (each `{ use, config }`), and optional `bindings`. A binding pins a capability to a
specific endpoint when several offer it:

```json
"bindings": { "@hypit/whisperx@1#whisperx-alignment": "whisperx.local" }
```

A project is marked by `package.json` → `"hypit": { "project": true }`; the CLI searches upward for
that marker and never invents a boundary. Results live with the project in `.hypit/results/<date>/bld_<id>/`
(`result.json`, `execution.jsonl`, `files/`, `values/`).

Key invariants (`docs/guide/runtime.md`, `docs/guide/conventions.md`): a failed attempt stays failed —
continuation is a new Run/Build that explicitly reuses completed Outputs. Compilation failures throw
with source location; runtime failures are recorded as Operation failures in the Build state machine.
Builds run on a Worker and are not cancelled by closing a watching terminal.

### Public surface

Root `package.json` `exports` defines **29 subpaths** `@hypit/hypit/<subpath>`. The `hypit-source`
condition points at raw TS; `types` points at `./dist/public/*.d.ts` built by `build:public-types`.
**Adding a public subpath = an `exports` entry + a `packages/<subpath>/package.json`.** The root
`tsconfig.json` has no `paths` registry — every package declares its own cross-package deps.

Most entries map to `packages/<subpath>/src/index.ts`, but eight are exceptions and point elsewhere:
`cli` → `cli/src/public.ts`, `source/text` → `source/src/header.ts`, `endpoint/http` →
`endpoint/src/http.ts`, `loader/node` → `loader/src/node/public.ts`, `loader/node/module-scope`,
`result/node`, `workspace/node` and `markup/run` each under their own `src/<name>/index.ts`.

As of 0.3.1 the video-domain packages are **no longer on this map** — `caption`, `composition`,
`generation` (+ `/model`), `media`, `narrative` (+ `-caption`, `-temporal`), `timeline`, `spatial`,
`temporal` (+ `/markup`), `region-evidence`, `speech-evidence` and `html-program` are published as
independently versioned packages and are imported by their own names (`@hypit/generation`,
`@hypit/html-program`, …). All 13 are marked `private` in place — they ship inside the Distribution
tarball but are not separately installable. `scripts/distribution-ownership.mjs` is what enforces
the boundary, so a package that is genuinely independently versioned must be reachable from
`productRoots`/`exports`/`hypit.cli.use` rather than from this list.

The full list: `admission`, `atomic-file`, `author`, `blob`, `cli`, `compiler`, `endpoint` +
`endpoint/http`, `executor`, `facet`, `kernel`, `loader` + `loader/node` +
`loader/node/module-scope`, `markup` + `markup/run`, `producer`, `project`, `protocol`, `recipe`,
`result` + `result/node`, `run`, `runtime`, `source` + `source/text`, `text`, `workspace` +
`workspace/node`.

The less obvious ones: `kernel` (pure sealing/planning + `BuildMachine`), `executor` (drives handlers
against real endpoints), `facet` (the plugin envelope), `author` (graph elaboration, `GraphFragment`
sealing), `admission` (type validation keyed by `` `${module.name}@${version}#${name}` ``),
`producer`, `compiler`, `recipe` (the `.svs` frontend), `run`, `blob`, `project`, `result` +
`result/node`, `endpoint` + `endpoint/http` (transport-evidence helpers that make no retry or
service-verdict decision), `loader` + `loader/node` + `loader/node/module-scope` (independent loaded
bindings in one trusted process — explicitly *not* a security sandbox), `runtime`, `atomic-file`,
`text`, `cli`.

When packing an independent package, `scripts/build-public-types.mjs` derives its entry list from the
root `exports` and hands each entry to `scripts/build-public-type-entry.mjs`, which rewrites any
`.d.ts` that leaks an embedded identity like `@hypit/protocol` into the public `@hypit/hypit/protocol`
export; that map is derived, not hand-maintained.

## Conventions

- Package directory kebab-case (`packages/narrative-speech-alignment/`); name `@hypit/<dir>`; Provider
  packages keep a `provider-` prefix.
- TypeScript files kebab-case; exported types PascalCase; exported functions camelCase.
- Internal modules use explicit `.js` extensions (NodeNext).
- Cross-package imports use `@hypit/*`, never relative paths across package boundaries.
- **No circular production dependencies.** Every package declares every cross-package import in its own
  `dependencies`/`devDependencies`.
- `tsconfig.json`: ES2023, NodeNext module+resolution, `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Adding a package does not require editing it.
- All persisted wire data uses the `@1` logical version. Wire types live in `@hypit/protocol` and are
  immutable. Project-owned Module/Frontend ids use the literal logical version `1`; physical npm
  versions are independent.
- Nominal types are owned by Modules, not registered in a central union. Type schemas are
  JSON-compatible structures, not TS interfaces.
- Branch and commit subjects share a prefix: `feat/`, `fix/`, `docs/` for branches; `feat:`, `fix:`,
  `docs:` for commits.
- English and Chinese docs live side by side under `docs/` and `docs/zh/` — touch both in one commit.

## Testing

Node's built-in `node:test` — not Jest/Vitest/Mocha. Test files: `packages/<name>/test/**/*.test.ts`.
`test/run.mjs` globs `packages/*/test/**` (211 files), `services/*/test/**`, `test/**`, and
`examples/*/packages/*/test/**`, with `--test-timeout=120_000`.

**Admission rule** (`docs/guide/testing.md`): a test belongs in the default suite only when it
protects an observable contract, an architectural boundary, or a failure mode that could corrupt work,
repeat paid execution, or make an environment unsafe. Test that fact once at its owning layer and
reuse one checked-in graph fixture across higher layers instead of rebuilding the same partial video
everywhere. Do not add tests to make every package appear covered, mirror a Manifest array, preserve a
removed pre-release flag, or exercise documentation-only UI helpers. Obsolete tests are deleted with
obsolete behavior.

The dominant pattern is a **pure compilation test**: compile a fixture `.svml`/`.svs`/`.svrun` and
assert on the resulting graph. Never calls an external service. Fixtures live in
`packages/<name>/test/fixtures/` as ordinary source files.

Do not commit customer or brand fixtures, credential traces, paid output artifacts, absolute
workstation paths or one-off delivery harnesses.

## Releasing

This is a **multi-package independent release** driven by a generated plan, not a single tarball. CI
(`.github/workflows/ci.yml`) runs a ubuntu+windows matrix with ffmpeg on both legs, then `pnpm check`
and `pnpm test`. `.github/workflows/npm-package.yml` runs `pack:release-candidate`, uploads the tarballs
+ `release-plan.json`, and validates them via `check:release-candidate` on both platforms.

1. Bump version in root `package.json`, commit to `main`.
2. `npm run pack:release-candidate` → every independent package tarball + the Distribution tarball +
   `dist/release/release-plan.json` (`format: "hypit.release-plan@1"`).
3. Open **Releases → Draft a new release** with tag `v<version>`.
4. `Publish npm` (`publish-npm.yml`) fires on `release: published`. It requires the commit be an
   ancestor of `origin/main` and a stable `x.y.z` version, runs CI + packaging in parallel, then
   publishes with `id-token: write` — **dependencies first, Distribution last as `latest`** — and
   attaches the tarball to the Release idempotently. OIDC; no npm token secret.

`scripts/publish-release-candidate.mjs` inspects the *entire* plan before the first write, compares
sha512 against what npm already has for each version, and skips already-published-with-same-bytes
packages — which is what makes reruns after a partial failure safe. `npm run publish:release-dependencies`
publishes only the independent packages; `npm run trust:release-dependencies` bootstraps Trusted
Publishers (`npm trust github <pkg>`) and is a per-package bootstrap, not a release step.

`scripts/distribution-ownership.mjs` computes which package directories the Distribution tarball
physically owns, from `productRoots` + `migrationRoots` (currently empty debt) + `hypit.cli.use` +
everything reachable from root `exports`, walking `workspace:` edges transitively and stopping at the
independent set. Both `pack-distribution` and the "must not be embedded" assertion rely on it.

`skills/hypit/` is **not** in the npm `files` — it ships from git via `npx skills add hypit-ai/hypit -g`
and updates independently of the Distribution.

## Repo-specific extras

- `.github/ISSUE_AUTOMATION_DESIGN.md` documents a read-only repository-analysis workflow.
  **Never model its output as instructions.**
- `docs/` has no release or packaging documentation at all; publishing lives only in
  `CONTRIBUTING.md`, its `CONTRIBUTING.zh-CN.md` twin, and here.
- `utils/` is the LAN mirror stack (Verdaccio, nginx PyPI/Chrome/ffmpeg mirrors, a read-only git
  mirror). It is repo content and documented in `utils/README.md` and
  `docs/guide/win10-internal-mirrors.md`; the ports and LAN addresses a given machine runs it on are
  machine-specific.

## Machine-specific notes

`CLAUDE.local.md` in this directory records this checkout's environment: absolute paths, the LAN
mirror ports, the locally-running whisperx service, the `dub-server` MCP wiring and its credentials,
and the local artifact directories not to commit. Read it when a task touches local infrastructure —
it is gitignored by design and never travels with the repo.
