# IbuJS v0.5 — TypeScript + JSX full-stack framework prototype

## Quick start

Requirements: Node.js >= 20.19, npm, access to npm registry.

```bash
npm install
npm run check
npm run dev
```

Open http://127.0.0.1:3000. To build and start: `npm run build && npm start`.

## Instant demo without installation

Open `demo/index.html` in a browser. It is a standalone offline UI demo using the IbuJS UI engine; the API tab uses a **simulated response**, not a real backend. The notes tab stores data in memory and resets on reload. `demo/screenshot.png` shows a browser capture.

## Modules and milestones

- v0.1: JSX DOM renderer, signals, basic Node HTTP server.
- v0.2: DOM reconciliation, dynamic client routing, CLI scaffolding.
- v0.3: server dynamic route params, request IDs, in-memory rate limiting, schema validation, minimal SSR helpers.
- v0.4: explicit effect and cleanup helpers, API fetch wrapper, incremental DOM engine retained.
- v0.5: signed session token helpers, password hashing, database adapter interface and in-memory example, notes API, additional tests.

## Commands

`npm run dev` starts the dev server. `npm run typecheck` checks TypeScript. `npm test` runs Node tests with tsx. `npm run build` bundles frontend and backend. `npm exec ibu -- create my-app` scaffolds a copy of the workspace.

## Security and limitations

The backend uses restricted static file mapping, security headers, a JSON size cap, request IDs, rate limits, signed sessions, and scrypt password hashes. Auth utilities are **not** an integrated login system. Sessions are stateless (no revocation store). In-memory rate limiting is single-process only; production needs a shared store and trusted proxy configuration. Database adapters require a real driver and parameterized queries. The SSR document helper requires trusted/escaped body HTML. The JSX DOM engine is a prototype and needs additional lifecycle and reconciliation coverage before production use. Do not deploy without an independent security review.

## Verification

In the creation environment, 8 direct Node runtime smoke checks passed against the transpiled server: password hashing, signed sessions, schema validation, memory storage, escaping, dynamic routes/request IDs, JSON parsing, and rate limiting. The standalone UI was exercised in headless Chromium (counter and notes). Full `npm install`, `npm run typecheck`, `npm test`, and `npm run build` could **not** be run because npm registry DNS was unavailable. The ZIP therefore contains a tested prototype, not a fully verified npm build.
