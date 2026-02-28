# CLAUDE.md

## Project Snapshot

T3 Code is a minimal web GUI for using code agents like Codex and Claude Code (coming soon).

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared Zod schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Cursor Cloud specific instructions

### Prerequisites

- **Bun >= 1.3.9** (package manager; see `packageManager` in root `package.json`).
- **Node.js >= 24.13.1** (required for `node:sqlite`; see `engines` in root `package.json`).
- **Codex CLI** on PATH is needed for full E2E agent sessions but is NOT required for dev server startup, lint, typecheck, or tests.

### Key commands

All commands are documented in the root `README.md`. Quick reference:

- `bun install` — install dependencies.
- `bun run lint` — runs `oxlint` (not ESLint).
- `bun run typecheck` — Turbo-orchestrated `tsc --noEmit` across all packages.
- `bun run test` — Turbo-orchestrated Vitest across all packages.
- `bun run dev` — starts contracts watch-build + server (port 3773) + Vite web (port 5733) via Turbo. Pass `T3CODE_NO_BROWSER=1` to suppress auto-opening a browser.
- `bun run build` — production build of all packages.

### Gotchas

- The server uses `node:sqlite` (experimental in Node 24). You will see `ExperimentalWarning: SQLite is an experimental feature` in test/server output — this is expected.
- Dev state is isolated to `~/.t3/dev` by default (set via `T3CODE_STATE_DIR`).
- `bun run dev` spawns `turbo` under the hood via `scripts/dev-runner.mjs`; the runner resolves dev ports (server 3773, web 5733) and environment variables automatically.
- `packages/contracts` must be built before `apps/server` or `apps/web` can start. Turbo handles this dependency, but if running individual packages manually, build contracts first: `bun run build:contracts`.
- Lint uses `oxlint` (config: `.oxlintrc.json`), not ESLint. Formatting uses `oxfmt` (config: `.oxfmtrc.json`).
