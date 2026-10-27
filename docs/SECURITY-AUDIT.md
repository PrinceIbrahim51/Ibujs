# IbuJS security audit (v0.5 → v0.6)

**Scope:** the complete v0.5 upload (`@ibujs/ui`, `@ibujs/server`, `@ibujs/cli`, starter app, standalone demo, tests, CI) and every v0.6 change.
**Date:** 2026-10-27. **Method:** manual code review, then each suspected issue reproduced against the *unmodified* v0.5 code (Chromium via Playwright for browser issues, real HTTP requests for server issues), fixed, and locked in with a regression test.

Evidence key: **Reproduced (browser)** = attacker code actually executed in Chromium; **Reproduced (HTTP)** = observed with real requests; **Code review** = established by reading the code, not executed.

## Summary

| Severity | Found in v0.5 | Fixed in v0.6 |
|---|---|---|
| Critical | 1 | 1 |
| High | 3 | 3 |
| Medium | 8 | 8 |
| Low | 7 | 7 |
| Informational | 3 | 3 (2 fixed, 1 documented) |

Plus 9 functional defects in v0.5, including two that stopped it from installing or running in production, and one regression caught during v0.6 development (section 3).

## 1. Security findings

| ID | Sev. | Area | Finding | Evidence | Fix in v0.6 | Regression test |
|---|---|---|---|---|---|---|
| F01 | **Critical** | UI renderer | Any object with a `type` field was treated as an element. Rendering API/database data such as `{comment.author}` let an attacker inject a live `<script>`, which executed. | Reproduced (browser): `{"type":"script","props":{"children":["…"]}}` ran. | Elements carry a `Symbol.for('ibujs.element')` brand that JSON cannot contain; plain objects as children throw `IBU106`. | e2e "JSON object as child", `ui.test.tsx` |
| F02 | High | UI renderer | `javascript:` URL filter was a regex that browsers bypass: tab, newline, or a leading control character inside the scheme. | Reproduced (browser): all three executed on click. | URLs are parsed with the WHATWG URL parser (identical to the browser's) and only `http(s)`, `mailto`, `tel`, `sms` and relative URLs are allowed; media `src` may also use `blob:` and image/audio/video `data:`. Unsafe values become `about:blank#blocked` and are reported (`IBU101`) instead of crashing the page. 19 URL-bearing attributes covered (v0.5: 5). | e2e (7 URL payloads), `isSafeUrl` matrix |
| F03 | High | UI renderer | `<iframe srcdoc>` accepted raw HTML. | Reproduced (browser): script in srcdoc ran. | `srcdoc`, `innerHTML`, `outerHTML`, `dangerouslySetInnerHTML`, `insertAdjacentHTML` and `http-equiv` are refused (`IBU102`). | e2e |
| F04 | High | UI renderer | `<script>` elements were created with `createElement` and executed when inserted (combined with F01, reachable from data). | Reproduced (browser). | `<script>` and `<base>` cannot be rendered (`IBU103`). | e2e |
| F05 | Medium | UI `api()` | Same-origin check only tested `startsWith('/')`; `'/\\evil.example/x'` resolves to `http://evil.example`. Callers could also override `credentials`. | Reproduced (browser): resolved origin `http://evil.example`. | Resolve like `fetch` does and compare origins; `credentials: 'same-origin'` and `mode: 'same-origin'` are fixed; 15 s default timeout. | e2e + `ui.test.tsx` (4 spellings) |
| F06 | Medium | Server routing | `new URL(req.url, base)` treated `//evil.example/api/hello` as host `evil.example` and path `/api/hello`, so the request was served by that route. Path-based checks (in middleware or a proxy) could disagree with routing. | Reproduced (HTTP): `200` with `/api/hello`'s response. | The request target must start with `/` and is parsed as a path only (`IBU413` for absolute-form targets). | `server-core.test.ts` |
| F07 | Medium | Server | No CSRF protection beyond `SameSite=Lax`; sibling-subdomain attacks and state-changing routes that do not read a JSON body were exposed. | Code review. | Built-in Fetch Metadata + Origin check (the algorithm of Go's `http.CrossOriginProtection`) for POST/PUT/PATCH/DELETE; same-origin, typed-URL and non-browser clients are unaffected; `trustedOrigins` / CORS origins opt in (`IBU412`). | `server-security.test.ts` (8 cases) |
| F08 | Medium | Auth | `scryptSync` blocked the event loop on every hash, so a few concurrent logins froze the whole server; cost used Node defaults below current OWASP guidance. | Code review; v0.6 test proves timers keep running while hashing. | Async scrypt (N=2^15, r=8, p=3), self-describing `$scrypt$` format, bounded parameters on verify, `needsRehash()`, timing-equalised check for unknown users. v0.5 hashes still verify. | `server-security.test.ts` |
| F09 | Medium | Rate limiting | Map grew without bound within a window (an IPv6 attacker controls 2^64 addresses), and each IPv6 address got its own bucket, so limits were trivially bypassed. | Code review. | IPv6 grouped per /64, hard `maxKeys` cap with oldest-first eviction, `RateLimit-Reset`, `trustProxy` support. | `server-security.test.ts` |
| F10 | Medium | SSR | `renderDocument(title, body)` inserted `body` as raw HTML. | Code review. | Only `SafeHtml` (from `html```, `renderToString`, `renderPage`) is inserted raw; plain strings are escaped. `SafeHtml` cannot be constructed outside the module. | `server-core.test.ts`, `ui.test.tsx` |
| F11 | Medium | Server errors | Unexpected exceptions were turned into 500s and never logged, so attacks and bugs left no trace (OWASP A09). | Code review. | `onError` hook (default: log with method, path, request id); clients get a generic message and the request id. | `server-core.test.ts` |
| F12 | Medium | Supply chain / CI | No lockfile, yet CI ran `npm ci` (always fails) and the README admitted install had never succeeded; dependencies would float on every install. | Reproduced (install failed, see D1). | `package-lock.json` committed, `npm ci` + `npm audit` in CI on Node 22 and 24, dependencies pinned to versions at least two weeks old. | CI |
| F13 | Low | Sessions | No key rotation, no revocation, cookie `Max-Age` fixed at 3600 s whatever the TTL, no `__Host-` prefix, non-canonical base64 signatures accepted, no `iat`. | Code review. | Versioned token with `iat`/`exp`/`jti`, multi-secret rotation, `isRevoked` hook, canonical signature check, `__Host-` cookie on HTTPS, `login`/`logout`/`require` helpers, placeholder/low-entropy secrets refused. | `server-security.test.ts` |
| F14 | Low | Body parsing | `__proto__` / `constructor.prototype` keys passed through to handlers; dangerous if merged into other objects. | Code review. | JSON reviver drops them; body cached so a second `ctx.body()` call no longer hangs. | `server-core.test.ts` |
| F15 | Low | Validation | `validateObject` only checked `typeof`: unlimited string lengths, no formats. | Code review. | Typed `s` validator: strings trimmed and capped at 10,000 chars by default, numbers finite, arrays capped, unknown keys dropped, `email`/`url` formats. `validateObject` kept for compatibility. | `server-data.test.ts` |
| F16 | Low | UI renderer | Unsafe URLs threw, so one malicious stored value crashed the page for every visitor (stored DoS). | Code review. | Neutralise and report instead of throwing (F02). | e2e |
| F17 | Low | Server | Node default timeouts (60 s headers, 300 s request) left room for slow-client attacks. | Code review. | 20 s headers, 60 s request, 5 s keep-alive, max 100 headers. | — |
| F18 | Low | Headers | Missing `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`, `Permissions-Policy`; no HSTS over HTTPS; page CSP only in the starter. | Code review. | All added; strict page CSP applied to every HTML response; HSTS when the request is HTTPS (directly or via a trusted proxy). | `server-core.test.ts` |
| F19 | Low | Static files | The starter hard-coded three files (safe but unusable); developers would write their own file server. | Code review. | `serveStatic()`: no `..`, no dotfiles, no NUL/backslash, symlink escapes blocked via `realpath`, SPA fallback, ETag/304, page CSP for HTML. | `server-security.test.ts` (9 traversal payloads) |
| I1 | Info | Server | 4xx error messages came from any thrown error's `message`. | Code review. | `HttpError(status, message)` makes public messages explicit; unexpected 5xx stay generic. | `server-core.test.ts` |
| I2 | Info | Demo | `demo/runtime/server.mjs` was a stale transpiled copy of the server with every server issue above. | Code review. | Removed; the demo is now generated from the real engine. | — |
| I3 | Info | Rate limiting | Behind a proxy all users share one bucket (socket address). | Code review. | Documented; `createServer({ trustProxy })` uses `X-Forwarded-For` correctly (right-most untrusted hop). | `server-core.test.ts` |

## 2. New protections added in v0.6

- **Open-redirect protection:** `ctx.redirect()` only follows same-site paths (`//evil`, `/\evil`, `javascript:` rejected); external targets need `{ allowExternal: true }`.
- **SQL injection prevention by construction:** `db.sql`...``` sends values as parameters; `db.query()` refuses plain strings (`IBU602`); `sql.identifier()` for vetted column names.
- **CORS:** explicit origin lists only; `"*"` with credentials refused (`IBU406`).
- **Secret hygiene:** `ibu create` writes a random `SESSION_SECRET` to a git-ignored `.env`; the client build fails if browser code imports server-only modules (`IBU702`); `ibu check` finds hard-coded keys.
- **AI safety:** API keys never reach the browser; `ai.route()` validates and caps input, rate-limits per visitor, caps concurrency, refuses client-supplied `system` roles, and cancels the upstream call when the visitor disconnects. `ibu ai` cannot write outside the project, to dotfiles, `package.json`, `packages/` or `node_modules`, and refuses code that fails the security lint.
- **`ibu check`:** 16 offline checks for the most common beginner and AI-assistant mistakes.

## 3. Functional defects found and fixed

| ID | Defect | Evidence |
|---|---|---|
| D1 | `npm install` failed: the starter depended on `@ibujs/*@0.1.0` but the packages were `0.5.0`, so npm went to the public registry (404). | Reproduced |
| D2 | `npm start` crashed: the server bundle kept workspace packages external, and Node cannot import their `.ts` sources from `node_modules`. | Reproduced (`ERR_MODULE_NOT_FOUND`) |
| D3 | The starter located assets with `new URL('../../../', import.meta.url)`, which points outside the project once bundled to `dist/server.mjs`. | Code review |
| D4 | Inputs did not clear after "Add note": `value` was set as an attribute, not the live property. | Reproduced (browser) |
| D5 | SVG never rendered: elements were created in the HTML namespace. | Reproduced (browser) |
| D6 | Keys on components (`<Item key={id} />`) were dropped, so lists of components diffed by index. | Found by a v0.6 test; same logic in v0.5 |
| D7 | HEAD requests got 404, wrong methods got 404 instead of 405, and `/users/:id` matched the literal text `:id` as an exact route. | Reproduced (HTTP) |
| D8 | Every signal write re-rendered synchronously (three writes, three renders) and a render error could leave a half-updated page. | Code review |
| D9 | `effect()` needed manual dependency lists and shared one global cleanup registry. | Code review |
| D10 | The request logger (v0.6 development) recorded `200` for errors handled later; caught by the built app and fixed before release. | Reproduced |

## 4. Verification

- 49 unit/integration tests (`npm test`) covering every fix above, run against real HTTP servers, a real SQLite database and a DOM.
- `npm run test:e2e`: 25 XSS payloads in Chromium with a *control* payload proving the harness detects execution. Result: control ran, 0 attack payloads executed.
- The built starter app was driven in Chromium under the production CSP with no CSP violations; `ibu create → install → typecheck → check → build → start` verified in a clean folder.
- AI features tested against a local mock of the Anthropic Messages API that records the exact requests (model, beta header, fallback, JSON schema, effort, caching), including refusals, rejected file paths, insecure generated code, missing keys, rate limits and client disconnects. **Not yet tested against the live Anthropic API** (no key in the audit environment).

## 5. Residual risks and limits (honest list)

No software can be guaranteed flaw-free, and this audit was done by the same assistant that wrote the fixes. Before production use, get an independent review. Known limits:

1. **Not independently audited**, and no fuzzing or formal verification yet.
2. **`ibu check` is pattern-based**: it catches common mistakes, not all vulnerabilities (e.g. missing ownership checks, business-logic flaws).
3. **AI-generated code** is linted and path-restricted, but malicious or subtly wrong *logic* (for example sending data to an external URL) can still pass. Always review `git diff` before running it, especially in repositories you cloned from others (prompt injection via file contents).
4. **Authorization is your job**: IbuJS gives sessions, not permissions. Check that the logged-in user owns each record.
5. **CSRF protection covers POST/PUT/PATCH/DELETE only**; never change state in GET handlers.
6. **Rate limiting is in-memory and per process**; use a shared store with several instances. Behind a proxy set `trustProxy`, or users share one bucket and session cookies cannot detect HTTPS.
7. **Sessions are stateless**: revocation requires the `isRevoked` hook backed by your database.
8. **Links to `https://` URLs from users are allowed** (they are not XSS but can be phishing); CSS values and `<style>` content are not sanitized, so never put user input in `<style>`.
9. **`node:sqlite` is marked experimental in Node 22** (it prints a warning) and needs 22.13+.
10. GitHub Actions are pinned to major tags, not commit SHAs.
