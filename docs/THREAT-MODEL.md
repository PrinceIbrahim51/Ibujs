# IbuJS threat model

What IbuJS protects, from whom, where the trust boundaries are, and which mechanism and test cover each threat. Reviewers: start here, then read `docs/SECURITY-REVIEW-SCOPE.md`.

## Assets

1. Users' sessions and accounts (session cookies, password hashes).
2. Application data in the database.
3. Secrets on the server: `SESSION_SECRET`, `ANTHROPIC_API_KEY`, database credentials.
4. The integrity of pages users see (no injected script or markup).
5. The developer's machine and repository when using `ibu ai`.
6. The money behind the developer's AI API key.

## Actors

| Actor | Can do |
|---|---|
| Anonymous visitor / attacker | Send any HTTP request; store data that other users see (comments, notes, profile fields) |
| Malicious website | Make a victim's browser send cross-site requests with their cookies |
| Logged-in user | Act within their session, try to reach other users' records (IDOR) |
| Malicious content in the repository | Files read by `ibu ai` (prompt injection), e.g. in a cloned project |
| The AI model | Return arbitrary text or code (treated as untrusted output) |
| Network attacker | Observe or modify traffic without HTTPS |

## Trust boundaries and entry points

```
Browser ──(HTTP)──► createServer handler ──► middleware ──► route handler ──► db.sql / AI / files
   ▲                    │  request target parsing        │ ctx.body(schema) │
   │                    │  CSRF / CORS / headers          │ authorize()      │
   └──── HTML/JSON ◄────┴── ctx.json / ctx.html(SafeHtml) / serveStatic ◄────┘
Browser DOM ◄── createApp / hydrate (renderer: security.ts policy) ◄── data from api()
Developer ── ibu ai ──► Claude API ──► proposed files ──► path checks + lint + consent ──► disk
```

## Threats, mitigations and tests

| # | Threat | Mitigation | Evidence |
|---|---|---|---|
| T1 | Stored/reflected XSS through rendered data | Text always escaped; no raw-HTML API; elements Symbol-branded; URL scheme allowlist on 19 attributes using the platform URL parser; `<script>`/`<base>`/`srcdoc`/inline handlers refused | `tests/e2e/security.e2e.mjs` (25 payloads in Chromium), `ui.test.tsx`, fuzz |
| T2 | XSS via server-side rendering differing from the browser | Same policy module for SSR and DOM; SSR escapes text and attributes | `fuzz.test.ts` (renderToString round-trip), `url-differential.e2e.mjs` (Node vs Chromium, 100k URLs: Node never approves a URL Chromium treats as dangerous; ~0.2% odd URLs are blocked only by SSR, the safe direction) |
| T3 | CSRF | Fetch Metadata + Origin check on unsafe methods; JSON-only bodies; SameSite=Lax cookies | `server-security.test.ts` |
| T4 | Session forgery / theft | HMAC-SHA256 with canonical signature check, rotation, revocation hook, HttpOnly + Secure + `__Host-` | `server-security.test.ts`, fuzz (mutated tokens) |
| T5 | Password cracking, login DoS | Async scrypt (OWASP params), bounded parameters, timing-equalised unknown users, per-route rate limits | `server-security.test.ts`, `guide.test.ts` |
| T6 | IDOR / broken access control | `definePolicy` deny-by-default, `authorize()` 401/403/404 | `authz.test.ts` (two-user HTTP scenario) |
| T7 | SQL injection | `db.sql```, parameters only; `db.query()` refuses strings; `sql.identifier()` allowlist pattern | `server-data.test.ts`, fuzz |
| T8 | Path traversal / dotfile disclosure | `serveStatic`: no `..`, dotfiles, NUL, backslashes; realpath containment | `server-security.test.ts`, fuzz (random request lines) |
| T9 | Request smuggling / host confusion | Request target must be a path; parsed without a base host | `server-core.test.ts`, fuzz |
| T10 | Resource exhaustion | 1 MB bodies with early abort, timeouts, rate limiting with /64 grouping and key cap, AI concurrency cap | `server-core.test.ts`, `server-security.test.ts`, `ai.test.ts` |
| T11 | Prototype pollution | JSON reviver drops `__proto__`/`constructor.prototype`; null-prototype cookie map; schemas copy known keys only | `server-core.test.ts`, fuzz |
| T12 | Secret leakage to the browser | Build fails on server-only imports in client code; `ibu check` rules; `.env` git-ignored (0600) | `check.test.ts`, build guard |
| T13 | AI key abuse / runaway cost | Keys server-only; `ai.route()` rate, size, concurrency limits; upstream cancelled on disconnect | `ai.test.ts` |
| T14 | Prompt injection through `ibu ai` | Model output is data: path allowlist, protected files, security lint, human confirmation, static-only verification unless `--test` | `ai.test.ts` |
| T15 | Supply-chain compromise | Lockfile, `npm audit` in CI, Dependabot, provenance on releases, packages built in CI from tagged commits | CI, `release.yml` |
| T16 | Open redirect | `ctx.redirect()` same-site unless `allowExternal` | `server-core.test.ts` |

## Out of scope (the application's responsibility)

Business-logic flaws, correct use of `authorize()` on every route, HTTPS termination and proxy configuration (`trustProxy`), database permissions and backups, content moderation, abuse of legitimate features, and reviewing AI-generated code before running it.
