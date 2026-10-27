# Why IbuJS? Positioning and comparison

## The one-line USP

**IbuJS is the full-stack JavaScript framework where the unsafe way doesn't exist: secure by default, built for AI to write, and simple enough for a first-time builder, in a 6 KB UI runtime.**

Vibe coders and beginners ship apps by prompting AI assistants. The assistant writes whatever the framework allows, and mainstream frameworks allow `innerHTML`, string-built SQL, secrets in browser bundles and unvalidated input. IbuJS removes those options, explains every mistake with an error code, and gives AI assistants a precise map of the right way.

## Four pillars

1. **Secure by default, not by discipline.**
   - No raw-HTML API at all: no `innerHTML`, `dangerouslySetInnerHTML` or `v-html` equivalent.
   - Elements are Symbol-branded (React's approach), so API data can never become markup.
   - URLs are allowlisted with the browser's own parser, identically on server and client.
   - CSRF protection, security headers and a strict CSP are on by default.
   - SQL goes through tagged templates only, so injection is impossible by construction.
   - The build fails if browser code imports server-only modules, so secrets cannot leak into the page.
   - Every protection has a regression test, including 25 real XSS payloads run in Chromium.
2. **AI-native.**
   - **Guided:** one obvious way to do each task, `llms.txt` (the complete API in one file) and `AGENTS.md`, so Claude Code, Cursor, Copilot and Codex write correct IbuJS from the first prompt.
   - **Guarded:** `ibu ai` changes are restricted to your source files, security-linted and shown to you before anything is written.
   - **Self-correcting:** after writing, `ibu ai` runs the TypeScript compiler, `ibu check` and (with `--test`) your tests, and sends failures back to Claude in the same conversation until they pass or the round limit is hit. `--branch` puts the result on its own git branch.
   - **Built in:** `ibu ai`, `ibu review` and `ibu explain --ai` work out of the box, and `@ibujs/ai` adds streaming AI features to *your* app with the key kept server-side and cost limits applied.
3. **Beginner-first.**
   - Every error has a code (`IBU412`) with a plain-English cause and fix, offline (`npx ibu explain IBU412`).
   - Shortcuts for the common cases: `bind={signal}` two-way inputs, `{count}` renders a signal, `resource()` loads data.
   - A real database with zero install (built-in SQLite).
   - `ibu create` writes a strong secret for you, and `ibu doctor` diagnoses setup problems.
4. **Small and full-stack in one project.**
   - About 6 KB gzipped UI runtime (measured below) plus a server with validation, sessions, authorization policies, rate limiting, static files and SSR with hydration.
   - Each component re-renders on its own when the signals it reads change; unchanged children are skipped and a crashing component does not take the page down.
   - `ibu build --target=vercel` deploys the same project to Vercel (CDN for static files, one function for the server).
   - One runtime dependency (the Anthropic SDK), used only by the AI features.

## Measured runtime size

Hello-world bundle per framework, minified with esbuild and gzipped (level 9), measured 2026-10-27:

| Runtime | Version | min | gzip |
|---|---|---|---|
| React + ReactDOM | 19.3.1 | 217.5 KB | 67.3 KB |
| Vue | 3.5.44 | 54.5 KB | 21.6 KB |
| Preact (+ hooks) | 10.29.8 | 12.5 KB | 5.2 KB |
| **IbuJS UI** (signals + renderer + hydration) | 0.7.0 | 14.8 KB | **6.3 KB** |
| **IbuJS UI** + router + `api()` | 0.7.0 | 19.0 KB | 8.0 KB |

IbuJS 0.6 was 5.1 KB; the 0.7 renderer adds per-component update scopes, memoization, error isolation and hydration for about 1.2 KB.

## Feature comparison

Node.js is a JavaScript *runtime* rather than a framework, so the "Node" column means the usual Node + Express setup. Other columns describe each tool's default setup as of October 2026; ecosystems move fast, so check their current docs before relying on a cell.

| | **IbuJS 0.7** | React (+ Vite) | Next.js | Vue | Node + Express | Vanilla JS |
|---|---|---|---|---|---|---|
| Scope | UI + server + DB + AI | UI library | Full-stack React | UI framework | Server only | None |
| Text escaped by default | ✅ | ✅ | ✅ | ✅ | n/a (templates vary) | ❌ (`innerHTML` common) |
| Raw-HTML escape hatch | **None** | `dangerouslySetInnerHTML` | same as React | `v-html` | yes | everywhere |
| `javascript:` URLs | Blocked (parser-based, 19 attributes) | Blocked in recent versions | same as React | Not sanitized (docs say: sanitize yourself) | n/a | not sanitized |
| Data can't become elements | ✅ Symbol brand | ✅ `$$typeof` Symbol | ✅ | ✅ in templates | n/a | n/a |
| CSRF protection by default | ✅ all write methods | n/a | Server Actions only | n/a | ❌ (add middleware) | n/a |
| Input validation | ✅ built-in typed `s` | ❌ (zod etc.) | ❌ (zod etc.) | ❌ | ❌ (express-validator) | ❌ |
| SQL injection-safe DB helper | ✅ `db.sql```, SQLite built in | ❌ | ❌ (bring ORM) | ❌ | ❌ | ❌ |
| Sessions + password hashing | ✅ built in | ❌ | ❌ (Auth.js etc.) | ❌ | ❌ (passport etc.) | ❌ |
| Authorization (who may touch which record) | ✅ `definePolicy`, deny by default | ❌ | ❌ (write your own) | ❌ | ❌ (CASL etc.) | ❌ |
| Security headers + CSP | ✅ default | n/a | configure yourself | n/a | ❌ (helmet) | ❌ |
| Secrets can't reach the browser bundle | ✅ build fails | ❌ | ✅ (`NEXT_PUBLIC_` convention) | ❌ | n/a | ❌ |
| Built-in security linter | ✅ `ibu check` | ESLint plugins (opt-in) | ESLint config | ESLint plugins | ❌ | ❌ |
| Error codes with plain-English fixes | ✅ every error, offline | partial (minified error links) | partial | partial | ❌ | ❌ |
| AI code generation in the CLI | ✅ `ibu ai` (checked, path-restricted, fixes its own type errors) | ❌ | ❌ | ❌ | ❌ | ❌ |
| AI reference + rules generated into every new app | ✅ `llms.txt`, `AGENTS.md` | not built in | not built in | not built in | not built in | n/a |
| AI endpoint helper with cost limits | ✅ `ai.route()` | ❌ | via AI SDK (separate) | ❌ | ❌ | ❌ |
| UI runtime (gzip, measured) | 6.3 KB | 67.3 KB | ≥ React | 21.6 KB | n/a | 0 KB |
| Rendering model | VDOM per component, signal-tracked, memoized, batched | VDOM per component | RSC + VDOM | Fine-grained reactivity + VDOM | n/a | manual |
| SSR | `renderToString` + `hydrate` (no streaming or static generation yet) | via frameworks | ✅ SSR/SSG/ISR/streaming | ✅ (Nuxt) | templates | n/a |
| Ecosystem and community | **Tiny (new)** | Huge | Huge | Large | Huge | n/a |
| Production track record | **None yet** | Very high | Very high | Very high | Very high | n/a |

## When to choose IbuJS (and when not)

**Choose IbuJS** for learning, prototypes, internal tools, hackathons, small and medium apps, and anything an AI assistant writes most of. It's also a good fit when one person must own the whole stack and should not have to know the OWASP Top 10 to stay safe.

**Choose something else (today)** for large apps that need a component ecosystem (React/Vue), SEO-heavy sites that need static generation, streaming SSR and file-based routing (Next.js/Nuxt), or high-traffic production systems that need a long security track record and a support community. The roadmap (`docs/ROADMAP.md`) lists what IbuJS needs to compete there.

## How IbuJS is different from "React + a security checklist"

Mainstream frameworks make safety *possible*; IbuJS makes it the *only path*. An AI assistant prompted with "show the user's bio as HTML" will reach for `dangerouslySetInnerHTML` in React or `v-html` in Vue. In IbuJS there is nothing to reach for. The renderer refuses with `IBU102`, and `ibu explain IBU102` tells the user (and the AI) the safe alternative.
