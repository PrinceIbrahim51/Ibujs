# Brief for an independent security review

This document is for an external security reviewer or audit firm. It defines what to review and how, so a review can be scoped and quoted quickly. IbuJS's own audit (`docs/SECURITY-AUDIT.md`) was done by the same AI assistant that wrote the code, which is exactly why an independent review is needed before 1.0.

## Where to find reviewers

- Independent application-security consultancies (ask for a source-code review plus a light penetration test of the starter app).
- Programs that fund audits of open-source projects, for example the Open Source Technology Improvement Fund (OSTIF).
- After launch: a public vulnerability disclosure policy (already in `SECURITY.md`), and optionally a bug bounty.

## Scope (highest risk first)

| Area | Files | Approx. size | Focus |
|---|---|---|---|
| Rendering security policy | `packages/ui/src/security.ts`, `vnode.ts`, `dom.ts`, `ssr.ts` | ~720 lines | XSS: URL allowlist, attribute/element blocks, hydration adopting server DOM, SVG/MathML edge cases, mutation XSS |
| HTTP core | `packages/server/src/app.ts`, `static.ts`, `cookies.ts` | ~460 lines | Request parsing, body limits, CSRF/CORS logic, error disclosure, static path containment |
| Auth | `packages/server/src/auth.ts`, `authz.ts` | ~250 lines | Session token design, password hashing, timing, policy evaluation |
| Data | `packages/server/src/db.ts`, `schema.ts` | ~230 lines | SQL tag composition, identifier handling, validation bypasses |
| AI | `packages/ai/src/index.ts`, `packages/cli/src/ai.mjs`, `check.mjs` | ~620 lines | Key exposure, cost abuse, prompt injection paths, write-path restrictions |
| Build and deploy | `packages/cli/src/build.mjs`, `scripts/release.mjs`, `.github/workflows/*.yml` | ~450 lines | Server-only import guard, Vercel output, release integrity |

Out of scope: the documentation, demo, and third-party dependencies (beyond how they are used).

## How to run everything

```bash
npm ci
npm run check                      # typecheck, tests, security lint, build
npm i --no-save playwright && npx playwright install chromium
npm run test:e2e                   # XSS payloads + Node/Chromium URL differential fuzz
FUZZ_RUNS=100000 npx tsx --test tests/fuzz.test.ts
npm run dev                        # the starter app at http://127.0.0.1:3000 (a target for testing)
```

The starter app has no accounts; `tests/guide.test.ts` and `tests/authz.test.ts` show the authentication and authorization patterns to attack.

## Questions we would like answered

1. Can any input reach script execution through `createApp`, `hydrate`, `renderToString` or `renderPage` on current Chromium, Firefox and Safari?
2. Can a cross-site request change state despite the CSRF check (including via redirects, `null` origins, or browser quirks)?
3. Can a session token be forged, replayed after revocation, or fixated?
4. Can `serveStatic` be made to serve anything outside its folder on Linux, macOS or Windows?
5. Can `ibu ai` be steered, through repository content, into writing outside the allowed paths or executing code without `--test`?
6. Are the documented defaults (`docs/THREAT-MODEL.md`) actually in effect in a fresh `npm create ibujs` app and in the Vercel deployment?

## Deliverables we expect

Findings with severity, reproduction steps and suggested fixes; a short retest after fixes; permission to publish a summary in `docs/`.
