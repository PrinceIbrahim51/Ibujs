# Roadmap and recommendations

Ordered by impact on making IbuJS a framework people can trust in production.

## Done in 0.7

- **Security review readiness:** property-based fuzzing (`tests/fuzz.test.ts`), a Node-vs-Chromium URL differential test, a threat model, a review brief with scope and setup (`docs/SECURITY-REVIEW-SCOPE.md`), CodeQL and Dependabot. *The review itself still has to be done by an independent third party.*
- **npm release pipeline:** `npm run release -- --verify` builds compiled packages and tests them in a fresh app; `.github/workflows/release.yml` publishes on `v*` tags with OIDC trusted publishing and provenance (`docs/RELEASING.md`). *Not published yet: needs the npm organization and trusted-publisher setup.*
- **Authorization helpers:** `definePolicy`, `owner`, `role`, `loggedIn`, `anyOf`, `allOf`, `actorFromSession`, deny by default.
- **Per-component rendering and hydration:** components re-render on their own when the signals they read change, unchanged children are skipped, render errors are isolated, and `hydrate()` adopts server-rendered HTML. `npm run bench` measures it (updating one row in a 1,000-row list: about 28× faster than 0.6).
- **`ibu ai` agent loop:** typecheck, `ibu check` and optional tests after each change, failures sent back to Claude, up to 5 fix rounds, `--branch` commits.
- **Vercel deployment:** `ibu build --target=vercel`, a `vercel.json` in new apps, and `create-ibumomujs`.

## Must do before 1.0

1. **Independent security review** using `docs/SECURITY-REVIEW-SCOPE.md`; fix its findings and publish the report.
2. **Finish npm publishing**: configure trusted publishers for the `@ibumomujs` organization, publish 0.7.0; then signed tags, an SBOM, and GitHub Actions pinned to commit SHAs.
3. **More auth**: account lockout, password reset via email tokens, OAuth (GitHub/Google), passkeys (WebAuthn), and an `ibu check` rule that warns when a route loads a record by id without calling `authorize`.
4. **Shared state for scale**: a session revocation store and rate limiter backed by SQLite/Redis, so several server processes behave as one.
5. **File uploads**: `multipart/form-data` with size, count and type limits, stored outside the web root. This needs its own security review.
6. **Database migrations**: `ibu db migrate` with versioned SQL files, plus typed query results.

## Performance and rendering

7. **Signal-to-DOM bindings**: per-component scopes (0.7) removed most diffing; binding signals straight to text and attributes (like Solid/Svelte 5) would remove the rest, and could win back the initial-mount time (0.7 mounts 1.1–2× slower than 0.6 in `npm run bench`).
8. **File-based routing, layouts, streaming SSR and static generation**, building on `hydrate()`. This is the path to SEO-friendly, Next.js-style apps.
9. **Benchmarks** in [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark), published with each release.

## Developer experience

10. **Live reload in the browser** during `ibu dev` (server-sent events) and source-mapped error overlays with `ibu explain` links.
11. **AST-based `ibu check`** (TypeScript compiler API or an ESLint plugin) for fewer false positives and data-flow checks (for example request data reaching `readFile`).
12. **`@ibumomujs/test`**: render components, fire events, and call routes without opening ports.
13. **Accessibility checks** (`ibu check --a11y`: labels, alt text, contrast hints) and i18n helpers.
14. **More deploy targets** (Docker, Fly.io, Render, Netlify), a persistent database option for serverless (Turso/libSQL or Postgres), health checks and graceful shutdown. Vercel is done.
15. A **docs website** with an interactive tutorial built on the standalone demo, and templates (blog, dashboard, chat, shop).

## AI

16. **Smarter `ibu ai`**: run the app and check it in a headless browser after changes, and send only the relevant files for large projects.
17. **An MCP server** exposing IbuJS docs, `ibu check` and `ibu explain` to any AI agent.
18. **An eval suite** measuring how often assistants produce correct, secure IbuJS code for 50 common tasks, used to improve `llms.txt` and `AGENTS.md`.
19. **Budgets in `@ibumomujs/ai`**: daily spend caps per app and per user, usage logging, optional moderation, and tool use for app actions with explicit permission prompts.
20. **Live API verification**: run the AI tests against the real Anthropic API in a protected CI job (they currently use a recorded-shape mock).

## Project health

21. A contribution guide, code of conduct, issue templates and a public roadmap board.
22. Check the "IbuJS" name for trademark/package collisions before a public launch.
