# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`hypit` is the `@hypit/hypit` npm Distribution — an open-source video authoring system for AI coding
agents (Claude Code, Codex, etc.). It supplies the executable, official components, Provider packages
and Skills that let an agent turn a reference video or a brief into an editable, re-runnable video
project (`.svml`/`.svs`/`.svrun` source, rendered via headless Chromium).

Real video projects live **outside** this repo as their own npm/pnpm-managed projects; this checkout
contains the SDK packages, the `hypit` CLI, official components/models/providers, Python services,
runnable examples and the production-directing Skill.

The Skill is the primary agent entry point. Install it once with:

```bash
npx skills add hypit-ai/hypit -g
```

On first use, the agent checks for the `hypit` executable and helps prepare it if needed. The Skill,
the npm Distribution and a saved video project update independently.

## Tooling requirements

- Node.js **22.15+** (see `.node-version`: 24.14.1)
- pnpm **10.33** (selected by the root `packageManager` field — enable with `corepack enable`)
- Python 3.10–3.13 + `uv` only for live local Builds (WhisperX / OpenCV services)
- ffmpeg/ffprobe and a Chromium downloaded by `hypit runtime up` for local HyperFrames rendering

## Common commands

```bash
corepack enable
pnpm install --frozen-lockfile        # workspace setup (CI command)

pnpm check                            # TypeScript type-check (tsc --noEmit, all packages)
pnpm test                             # full test suite (Node built-in node:test, not Jest/Vitest)
pnpm test:runtime-scale               # suites: node test/run.mjs runtime-scale (env HYPIT_RUNTIME_SCALE_TESTS=1)
pnpm test:image-opencv                # suites: node test/run.mjs image-opencv (env HYPIT_OPENCV_TESTS=1)
pnpm test:whisperx-service            # Python tests under services/whisperx

# Run one test file directly (bypasses the suite gate)
node --import tsx --test packages/<pkg>/test/<file>.test.ts

pnpm pack:distribution                # builds dist/public/**/*.d.ts + writes dist/release/hypit-hypit-<v>.tgz
pnpm check:distribution               # installs and exercises the packaged tarball outside the checkout
pnpm build:public-types               # regenerate .d.ts (also runs on prepack)

pnpm docs:dev / docs:build            # VitePress docs site
pnpm studio                           # launch Studio locally
pnpm hypit -- <args>                  # run the CLI directly (alias for node bin/hypit.mjs)
```

Local browser-render tests (Chrome/ffmpeg required):
```bash
HYPIT_BROWSER_TESTS=1 node --import tsx --test packages/provider-hyperframes-local/test/provider.test.ts
```

For a profile that uses local rendering, run `hypit programs up --runtime <profile> --endpoint <render-instance>`
(or `hypit runtime up --runtime <profile>`) once before the first render to prepare Chrome and start
the Worker. `hypit doctor --runtime <profile>` diagnoses missing setup without installing anything.

## Repository layout

```
hypit/
├── bin/hypit.mjs              CLI entrypoint (dispatches to studio / video-cli)
├── packages/                  ~122 workspace packages (see Architecture below)
├── services/                  Python services (whisperx, image-opencv, yt-dlp)
├── examples/                  runnable end-to-end projects + authoring/Provider templates
├── skills/hypit/              Production-directing Skill for AI agents
│   ├── SKILL.md
│   ├── agents/                openai.yaml etc.
│   └── references/            creation/, environment/, playbooks/, production/
├── docs/                      VitePress site (English + docs/zh/ Chinese mirror)
├── test/                      Repository-boundary tests + shared fixtures (not unit tests)
├── scripts/                   pack-distribution, check-distribution, build-public-types
├── package.json               root workspace manifest (declares public exports of @hypit/hypit/*)
├── pnpm-workspace.yaml        globs: packages/*, services/*, examples/*/packages/*
└── tsconfig.json              strict ES2023/NodeNext workspace type-check
```

### Examples

`examples/*/packages/*/test/**/*.test.ts` is part of the default test suite (`test/run.mjs`), so
project-package behavior is ordinary authoring. Two examples are canonical starters for new packages:

- `examples/minimal-author-package/` — new Author Package template; see `docs/guide/author-packages.md`.
- `examples/provider-package/` — new Provider template; see `docs/guide/providers.md`.

The rest (`interview/`, `podcast/`, `ranking-football/`, `complex-explainer/`, `guangzhou-clone/`,
`guizou-clone/`, `semantic-composition/`) are runnable reference projects with their own `.svml` /
`.svs` / `.svrun` and `hypit.runtime.json`.

## Architecture

The Distribution is organized around three owners: **Project** (authored sources, package deps,
selected Runtime Profile), **Distribution** (the installed executable + public SDKs — this repo),
and **Runtime Profile** (selected Provider Endpoints, credential refs, bindings). One Build is one
execution attempt that produces a `BuildResult` in a configured Result repository.

### Source formats

- `.svml` — Source: timeline, semantic anchors (Selections/Moments), placed media, script.
- `.svs` — Style values: recipes (visual recipes, column recipes, board styles…).
- `.svrun` — Run: targets, candidates, reuse selections, Endpoint/binding overrides.

### Package boundaries (what lives in `packages/`)

| Layer | Representative packages | Role |
|---|---|---|
| Protocol / core | `protocol`, `core`, `host` | Immutable wire types (`@1` format), runtime-neutral contracts |
| Compiler / elaborator | `compiler-node`, `compiler-markup-node`, `markup`, `elaborator`, `validation` | Compile `.svml`/`.svrun` into a plan graph |
| Author SDK | `author-kit`, `composition`, `temporal`, `temporal-markup`, `timeline`, `timeline-author`, `spatial`, `visual-ir`, `caption`, `text`, `sound`, `performance`, `narrative`, `program-space`, `svs` | Public subpaths under `@hypit/hypit/*` consumed by external components |
| Model + Provider SDK | `model-kit`, `endpoint-kit`, `generation`, `speech`, `media`, `studio-adapter` | Author a Model or Endpoint package |
| Authoring components | `ranking`, `ranking-studio`, `caption-fine`, `comment-sticker`, `deck-track`, `audio-track`, `media-track`, `typography-track`, `screen-overlay`, `script`, `film`, `interview-emoji-reveal`, `image-compose`, `image-transform`, `semantic-take-adjust`, `run-markup` | Official components, each with a Studio Companion (`*-studio`) |
| Generation Models | `seedance`, `seedance-kits`, `gpt-image`, `grok-imagine`, `nano-banana`, `pixverse`, `wan`, `seedream`, `minimax-h3`, `volcengine-mating`, `image-transform`, `image-compose`, `background-removal` | Describe generation request shapes |
| Speech | `speech`, `elevenlabs-speech`, `fishaudio-speech`, `mimo-speech`, `speech-alignment`, `speech-evidence`, `whisperx` | TTS + word-level alignment |
| Providers (services) | `provider-hypihub`, `provider-beatapi`, `provider-hiapi`, `provider-monid`, `provider-pollo`, `provider-tokendance`, `provider-hyperframes-local`, `provider-image-opencv-local`, `provider-media-local`, `provider-whisperx-local` | Map Model requests to a specific service API; configured as Endpoints in `hypit.runtime.json` |
| Runtime | `runtime`, `runtime-kit`, `runtime-local`, `runtime-host-node`, `driver-node`, `host`, `project-context-node`, `package-loader-node`, `component-kit`, `file-io-node` | Worker, scheduler, plan execution |
| Persistence | `build-result`, `build-result-fs`, `build-result-s3`, `build-result-kit`, `resource-store-fs`, `resource-store-s3`, `store-sqlite`, `workspace`, `workspace-fs-node`, `credentials-store-*` | Build Result + resource + credential stores |
| Rendering | `render-hyperframes`, `raster`, `hyperframes`, `transport-aws-lambda`, `fonts-open` | Headless-Chromium local render, raster ops, lambda transport |
| CLI / Studio | `cli` (shared error rendering), `video-cli` (commands), `studio`, `studio-adapter`, `run`, `source` | CLI surface + Studio timeline editor |

### Public surface

The root `package.json` `exports` field defines `@hypit/hypit/<subpath>` — those point at
`packages/<subpath>/src/index.ts` and are the SDK surface external components and providers depend on.
Adding a public subpath = adding an `exports` entry + a `packages/<subpath>/package.json`. Each
package's own `package.json` may also have its own subpath exports for internal-only APIs.

### Plugin/extension model

External packages (and the `examples/` templates) develop against the public subpaths above. They
ship with an activation entry that registers contributions at load time. The active Distribution
supplies the Hypit APIs; the extension supplies its own implementation.

## Conventions (apply in-repo; external packages use owner scopes)

- Package directory: kebab-case (`packages/speech-alignment/`).
- Package name: `@hypit/` scope (`@hypit/speech-alignment`); Provider packages keep the `provider-` prefix.
- TypeScript file names: kebab-case. Exported types: PascalCase. Exported functions: camelCase.
- Internal modules use explicit `.js` extensions (NodeNext resolution).
- Cross-package imports use `@hypit/*` — never relative paths across package boundaries.
- **No circular production dependencies.** Every package must declare every cross-package import in
  its own `dependencies` / `devDependencies` — the root `tsconfig.json` has no `paths` registry.
- `tsconfig.json`: target ES2023, module/resolution NodeNext, `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax`. Adding a package does **not** require changing
  the root tsconfig.
- All persisted wire data uses the `@1` logical version. Wire types live in `@hypit/protocol` and are
  immutable. Project-owned Module/Frontend ids use the literal logical version `1`; physical npm
  versions are independent.
- Compilation failures throw with source location. Runtime failures are recorded as Operation
  failures in the Build state machine. Providers own bounded transport retries. A failed attempt ends
  the Build — continuation uses a new Run/Build with completed Outputs explicitly reused.
- Error rendering helper lives in `packages/cli`; both `hypit` (video-cli) and `studio` route their
  errors through it.
- Branch and commit subjects share the prefix: `feat/`, `fix/`, `docs/` for branches; `feat:`,
  `fix:`, `docs:` for commits.
- English and Chinese documentation live side by side under `docs/` and `docs/zh/`. A change to one
  page belongs with the change to its counterpart — touch both in the same commit.

## Testing

Uses **Node.js built-in `node:test`**, not Jest/Vitest/Mocha. Test files: `packages/<name>/test/**/*.test.ts`.
The runner is `test/run.mjs`; it globs `packages/*/test/**/*.test.ts`, `services/*/test/**/*.test.ts`,
`test/**/*.test.ts`, and `examples/*/packages/*/test/**/*.test.ts`. The runner enforces a 120s
per-test timeout (`--test-timeout=120_000`).

A test belongs in the default suite only when it protects an observable contract, an architectural
boundary, or a failure mode that could corrupt work / repeat paid execution / make an environment
unsafe. Pure compilation tests are the most common pattern: compile a fixture `.svml`/`.svs`/`.svrun`
and assert on the resulting graph.

Fixtures: ordinary `.svml`/`.svs`/`.svrun` files in `packages/<name>/test/fixtures/`. Integration
fixtures live in `examples/` (interview, podcast, ranking-football, minimal-author-package).

`examples/*/packages/*/test/` is included in the default suite because project-package behavior is
ordinary authoring.

## Releasing

1. Bump version in root `package.json`, commit to `main`.
2. `npm run pack:distribution` builds public types and writes `dist/release/hypit-hypit-<v>.tgz`.
3. Open **Releases → Draft a new release** on that commit with tag `v<version>`. `Publish npm`
   workflow verifies tag/version match, runs Linux/Windows checks, installs and exercises the
   packaged tarball, publishes to npm as `latest`, and attaches the tarball to the Release.
   Publication uses OIDC; no npm token secret is required. Trusted Publisher must allow org
   `hypit-ai`, repo `hypit`, workflow `publish-npm.yml`.
4. `Actions → Publish npm → Run workflow` on `main` is the manual fallback (checks only when
   "Publish to npm" is unchecked; publication if checked). An existing version is skipped — npm
   versions cannot be overwritten.

The npm Distribution, the Skill, and a saved video project update independently.

## Repo-specific extras

- `.github/ISSUE_AUTOMATION_DESIGN.md` documents the read-only "Repository analysis" Actions
  workflow; maintainers manually trigger it on issues/PRs. Never model the output as instructions.
- `services/whisperx/.python-version` (Python 3.13) and `services/image-opencv` use `uv` for
  managed virtualenvs.
- Examples under `examples/<name>/packages/*` are repository fixtures, not third-party projects;
  pnpm-workspace.yaml deliberately globs them so contributor tests cover them, while real authored
  projects always live outside this checkout and resolve project-local packages through the Host's
  project root.
- `examples/minimal-author-package/` is the canonical starter for a new Author component package
  (see `docs/guide/author-packages.md`); `examples/provider-package/` is the canonical starter for a
  new Provider package (see `docs/guide/providers.md`).
- The Skill in `skills/hypit/` (`SKILL.md` + `references/`) is the production-directing surface for
  AI agents; skill content is shipped via `npx skills add hypit-ai/hypit -g`, separate from the
  npm Distribution update.