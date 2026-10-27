# Security policy

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting ("Report a vulnerability" under the Security tab), with steps to reproduce and the affected version. We aim to acknowledge reports within 3 days.

## Supported versions

| Version | Supported |
|---|---|
| 0.7.x | ✅ |
| 0.6.x | ❌ (upgrade to 0.7; no breaking security changes) |
| ≤ 0.5 | ❌ (known critical issues, see `docs/SECURITY-AUDIT.md`) |

## Security model

IbuJS aims to make the safe way the only easy way. Defaults you get without configuration:

| Threat | Default protection | Escape hatch (greppable) |
|---|---|---|
| XSS via rendering | Text always escaped; no raw-HTML props; `<script>`/`<base>` refused; Symbol-branded elements; URL scheme allowlist (browser-identical parser) on 19 attributes; strict CSP on HTML responses | None for raw HTML; `pageCsp` option |
| CSRF | Fetch Metadata + Origin check on POST/PUT/PATCH/DELETE | `csrf: { trustedOrigins }`, `csrf: false` (flagged by `ibu check`) |
| SQL injection | `db.sql```, parameters only; `db.query()` refuses strings | `db.raw()` (interpolation flagged by `ibu check`) |
| Secret leakage | Client build fails on server-only imports; `ibu check` finds hard-coded keys; `.env` git-ignored; `ibu create` generates a random secret | — |
| Session theft/forgery | HMAC-SHA256 signed, HttpOnly, SameSite=Lax, `__Host-` + Secure on HTTPS, key rotation, revocation hook | `cookieName` option |
| Password cracking | scrypt N=2^15, r=8, p=3 (async), 12+ characters, timing-equalised unknown users | — |
| Open redirects | `ctx.redirect()` same-site only | `{ allowExternal: true }` (flagged) |
| Path traversal | `serveStatic()` blocks `..`, dotfiles, NUL, backslashes, symlink escapes | — |
| Abuse / DoS | 1 MB JSON bodies, slow-client timeouts, `rateLimit()` with IPv6 /64 grouping and memory cap | options |
| Prototype pollution | `__proto__` / `constructor.prototype` stripped from JSON bodies; cookie map has no prototype | — |
| Broken access control (IDOR) | `definePolicy` denies everything not listed; `authorize()` answers 401/403, or 404 with `{ hide: true }` | — (you must call `authorize` in each route) |
| AI cost and key abuse | Keys server-only; `ai.route()` rate, size, concurrency limits, cancels on disconnect | options |

Things IbuJS cannot do for you: deciding your authorization rules and calling `authorize()` on every route that touches a record, safe business logic, secure hosting configuration, and reviewing AI-generated code before running it. Read the residual-risk list in `docs/SECURITY-AUDIT.md`.
