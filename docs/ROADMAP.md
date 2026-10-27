# Roadmap and recommendations

Ordered by impact on making IbuJS a framework people can trust in production.

## Must do before 1.0

1. **Independent security review** of `packages/ui/src/security.ts`, `packages/server/src/app.ts`, `auth.ts` and `static.ts`, plus fuzzing (URL sanitiser, request parsing, cookie parsing, static paths) and a public vulnerability disclosure process.
2. **Publish to npm properly**: SemVer, `npm publish --provenance`, signed tags, a changelog per release, Renovate/Dependabot, an SBOM, and GitHub Actions pinned to commit SHAs. Today apps vendor the framework under `packages/`.
3. **Authorization helpers**: ownership checks and roles (`can(user, 'edit', note)`), the most common gap after authentication. Also account lockout, password reset via email tokens, OAuth (GitHub/Google), and passkeys (WebAuthn).
4. **Shared state for scale**: a session revocation store and rate limiter backed by SQLite/Redis, so several server processes behave as one.
5. **File uploads**: `multipart/form-data` with size, count and type limits, stored outside the web root. This needs its own security review.
6. **Database migrations**: `ibu db migrate` with versioned SQL files, plus typed query results.

## Performance and rendering

7. **Fine-grained updates**: today the whole view re-renders and diffs on each (batched) change. That's fine for typical apps but not for big lists or animations. Binding signals directly to DOM text and attributes (like Solid/Svelte 5), or per-component update scopes, would remove most diffing.
8. **Hydration** for `renderToString` output, then file-based routing and layouts. This is the path to SEO-friendly, Next.js-style apps.
9. **Benchmarks** in [js-framework-benchmark](https://github.com/krausest/js-framework-benchmark), published with each release.

## Developer experience

10. **Live reload in the browser** during `ibu dev` (server-sent events) and source-mapped error overlays with `ibu explain` links.
11. **AST-based `ibu check`** (TypeScript compiler API or an ESLint plugin) for fewer false positives and data-flow checks (for example request data reaching `readFile`).
12. **`@ibujs/test`**: render components, fire events, and call routes without opening ports.
13. **Accessibility checks** (`ibu check --a11y`: labels, alt text, contrast hints) and i18n helpers.
14. **`ibu deploy` adapters** (Docker, Fly.io, Render, serverless), health checks and graceful shutdown.
15. A **docs website** with an interactive tutorial built on the standalone demo, and templates (blog, dashboard, chat, shop).

## AI

16. **Agent loop for `ibu ai`**: after applying a change, run typecheck, `ibu check` and tests, feed failures back, and fix automatically (with a turn limit). Offer to commit on a new git branch.
17. **An MCP server** exposing IbuJS docs, `ibu check` and `ibu explain` to any AI agent.
18. **An eval suite** measuring how often assistants produce correct, secure IbuJS code for 50 common tasks, used to improve `llms.txt` and `AGENTS.md`.
19. **Budgets in `@ibujs/ai`**: daily spend caps per app and per user, usage logging, optional moderation, and tool use for app actions with explicit permission prompts.
20. **Live API verification**: run the AI tests against the real Anthropic API in a protected CI job (they currently use a recorded-shape mock).

## Project health

21. A contribution guide, code of conduct, issue templates and a public roadmap board.
22. Check the "IbuJS" name for trademark/package collisions before a public launch.
