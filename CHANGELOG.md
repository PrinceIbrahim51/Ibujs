# Changelog

## 0.7.0 (2026-10-27)

### Added
- **Rendering engine v2 (UI):** every component has its own update scope and re-renders only when the signals it reads change (parents first, batched per microtask). Children with shallow-equal props are skipped. A component that throws keeps its last output while the rest of the page keeps working. `hydrate(App, target)` adopts HTML from `renderToString`/`renderPage` and falls back to a fresh render on mismatch (`IBU206`). Updating one row in a 1,000-row list is about 28× faster (`npm run bench`).
- **Authorization (server):** `definePolicy`, `owner`, `role`, `loggedIn`, `anyOf`, `allOf`, `actorFromSession`. Deny by default, async rules, `can` / `authorize` (401, 403 `IBU506`, or 404 with `{ hide: true }`) / `filter`.
- **`ibu ai` agent loop:** after applying a change it runs `tsc --noEmit` and `ibu check` (and `npm test` with `--test`), sends failures back to Claude in the same conversation and applies the fixes, up to `--fix-rounds=N` (default 2). `--branch[=name]` works on a new git branch and commits only the generated files. `--no-verify` turns the checks off.
- **Deploy to Vercel:** `ibu build --target=vercel` writes `.vercel/output` (Build Output API v3: static files on the CDN with the same security headers, the server as one streaming Node function). New apps get a `vercel.json`, a `build:vercel` script and a `.vercelignore` that keeps `.env` and database files out of `vercel deploy` uploads. The framework's own starter runs at https://ibujs.vercel.app.
- **npm packaging:** `npm run release` builds compiled `.js` + `.d.ts` packages into `.release/` (`--verify` installs the tarballs into a fresh app and runs it); `.github/workflows/release.yml` publishes on `v*` tags with trusted publishing and provenance; new `create-ibujs` package (`npx create-ibujs my-app`); `ibu create --npm` / `--vendor`.
- **Security assurance:** seeded property-based fuzz tests (`tests/fuzz.test.ts`), a Node-vs-Chromium URL differential test, `docs/THREAT-MODEL.md`, `docs/SECURITY-REVIEW-SCOPE.md`, CodeQL and Dependabot.
- Error codes `IBU206`, `IBU506`, `IBU507`, `IBU604`, `IBU904`.

### Changed
- The UI runtime is 6.3 KB gzipped (was 5.1 KB).
- `trustProxy` defaults to one hop when running on Vercel (`VERCEL=1`).
- `app.listen()` does not open a port when `IBU_SERVERLESS=1` (set by the Vercel entry); it registers the handler instead.
- On serverless hosts a relative SQLite filename is placed in the temp folder, with warning `IBU604`.
- The default error log prints expected `HttpError`s on one line.

### Upgrading from 0.6
- Components now re-render on their own. If you changed an object or array **in place** and relied on the parent re-rendering, the child may now be skipped: assign a new value instead (`list.update(l => [...l, x])`), which IbuJS already required.
- `router.view()` renders the route component as a component (its own update scope) instead of calling it directly. Route components receive the same params.
- Tests that count renders may see fewer renders.

## 0.6.0 (2026-10-27)

A security-focused rebuild after a full audit of 0.5 (see `docs/SECURITY-AUDIT.md`).

### Added
- **UI:** `computed`, auto-tracking `effect`, `batch`, `untrack`, `resource`, `nextTick`; `bind={signal}`; `ref`; `class` arrays/objects; style objects with automatic `px`; SVG; signals as children; router `Link`, hash mode, `base`, wildcards, `query()`; `api.get/post/put/patch/delete/stream` with timeouts and `ApiError`; `renderToString`, `html```, `SafeHtml`; `onSecurityViolation`; development error overlay.
- **Server:** typed `s` validator and `ctx.body(schema)`; `HttpError`; `ctx.text/html/empty/redirect/cookies/query/ip/secure/state`; route-level middleware; HEAD and 405; built-in CSRF protection, CORS, request ids, security headers and timeouts; `trustProxy`; `logger()`; `serveStatic()` and `publicDir()`; `sql``` / `createDatabase` / `sqliteDatabase`; session `login/logout/require/middleware`, key rotation, revocation; `needsRehash`; `renderPage`.
- **AI:** `@ibujs/ai` (`createAI`, `ask`, `stream`, `route`); CLI `ibu ai`, `ibu review`, `ibu explain [--ai]`; `llms.txt`, `AGENTS.md`, `CLAUDE.md`.
- **CLI:** `ibu check`, `ibu doctor`, `ibu secret`, `ibu.config.json`; `ibu create` generates a standalone app with a random `SESSION_SECRET`.
- Error catalog: every error has an `IBUxxx` code.
- Tests: 49 unit/integration tests, a Chromium XSS suite, CI on Node 22 and 24.

### Fixed
- 19 security issues (1 critical, 3 high, 8 medium, 7 low) and 9 functional defects, including `npm install` and `npm start` failing in 0.5.

### Breaking changes and migration from 0.5
- **Node.js 22.13+** is required (built-in SQLite; Node 20 is end-of-life).
- `hashPassword` / `verifyPassword` are **async**: add `await`.
- `createDatabase(adapter).query()` only accepts `sql```. Change `db.query(text, params)` to `db.raw(text, params)` or, better, `` db.sql`...` ``.
- `renderDocument(title, body)` escapes a plain-string `body`. Pass `html```/`renderToString()` output for markup.
- Session tokens use a new format (`v1.…`): existing sessions are invalid after upgrading, so users log in again.
- `memoryDatabase().insert()` returns the stored row (with `id`) instead of the record count.
- `effect(fn, deps?)` returns a dispose function and tracks signals automatically.
- Re-renders are batched per microtask: in tests, `await nextTick()` before reading the DOM.
- `createApp` replaces any existing content in its target, and also accepts a CSS selector.
- Unsafe URLs are replaced with `about:blank#blocked` (and reported) instead of throwing. Rendering a plain object as a child throws `IBU106`.
- Cross-site browser POST/PUT/PATCH/DELETE requests are rejected (`IBU412`). Allow trusted origins with `createServer({ csrf: { trustedOrigins } })` or `cors`.
- `requestIds()` is now a no-op: request ids are built in.
- The starter moved from `examples/starter` to `packages/cli/template`; the project layout is configured with `ibu.config.json`.
