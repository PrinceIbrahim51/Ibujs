# Working on the IbuJS framework

This repository is the framework itself. App-level rules for AI assistants live in `packages/cli/template/AGENTS.md` (copied into every new app); the API reference is `llms.txt`.

## Layout

- `packages/ui`: signals, JSX runtime, DOM renderer, router, `api()`, `renderToString`. Security policy in `src/security.ts` is shared by the DOM renderer and SSR.
- `packages/server`: HTTP server (`src/app.ts`), schema, cookies, auth, rate limiting, SQL, static files, SSR helpers.
- `packages/ai`: server-only Claude helpers.
- `packages/cli`: the `ibu` command (`src/*.mjs`, plain JavaScript so it runs without a build), the error catalog (`src/errors.json`) and the app template (`template/`, also used by `npm run dev` here).
- `tests/`: Node test runner suites; `tests/e2e/security.e2e.mjs` runs XSS payloads in Chromium.

## Rules

- Secure by default: never add an API that turns strings into HTML or code, or that disables a protection without an explicit, greppable option.
- Every new error gets a code in `packages/cli/src/errors.json` and a hint in the thrown `IbuError`.
- Keep `llms.txt` in sync with public API changes; AI-generated apps depend on it.
- No new runtime dependencies without discussion (the only one is `@anthropic-ai/sdk` in `@ibujs/ai` and the CLI).

## Checks

`npm run check` (typecheck, tests, security lint, build) and `npm run test:e2e` (needs Playwright + Chromium).
