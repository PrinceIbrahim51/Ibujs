# Changelog

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
