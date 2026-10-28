# Instructions for AI coding assistants

This is an IbuJS app. Read `llms.txt` for the complete API before writing code. Use only IbuJS APIs, Node.js built-ins and packages already in package.json.

## Layout

- `src/main.tsx`: browser code (@ibumomujs/ui). Never import @ibumomujs/server, @ibumomujs/ai, node:* or secrets here; the build fails if you do.
- `src/server.ts`: server code (@ibumomujs/server, @ibumomujs/ai). API routes live under `/api/`.
- `index.html`: page shell. No inline `<script>` or `style=""` (the Content-Security-Policy blocks them).
- `.env`: secrets (git-ignored). Read with `process.env.NAME` on the server only.

## Security rules (non-negotiable)

1. Validate every request body and param with a schema: `await ctx.body(s.object({...}))`, `s.number({ coerce: true }).parse(ctx.params.id)`.
2. Query only with `db.sql\`... ${value}\``. Never concatenate or interpolate values into SQL text.
3. Never use innerHTML, outerHTML, insertAdjacentHTML, document.write, dangerouslySetInnerHTML, eval, new Function or string event handlers. Render JSX children; text is escaped automatically.
4. Secrets (API keys, SESSION_SECRET) come from `process.env` on the server. Never hard-code them and never send them to the browser.
5. Passwords: `hashPassword` / `verifyPassword`. Sessions: `createSessionManager({ secret: process.env.SESSION_SECRET! })` and `sessions.require(ctx)` on protected routes. Check that the logged-in user may touch the record: load it, then `await policy.authorize(actorFromSession(session), 'update', record)` with a policy from `definePolicy` (deny by default). Never trust an owner id sent by the browser.
6. Redirect only to paths on this site (`ctx.redirect('/x')`). Do not set `allowExternal` with user input.
7. Do not disable built-in protections (`csrf: false`, CORS `'*'`, `rejectUnauthorized: false`).
8. AI features use `@ibumomujs/ai` on the server (`ai.route()`), and the page reads answers with `api.stream()`. Render AI output as text.

## Style

- Keep state in signals; create new arrays/objects instead of mutating (`list.update(l => [...l, x])`).
- Give list items a stable `key` (an id, not the index).
- Split big pages into components: each one re-renders only when the signals it reads change.
- If the server renders the page (`renderPage`), start the browser app with `hydrate` instead of `createApp`.
- Throw `new HttpError(status, 'Message for the user')` for expected failures.
- Small, readable functions; comments only where intent is not obvious.

## Before you finish

Run `npx ibu check` (security), `npm run typecheck`, and for UI changes `npm run dev` and try it in the browser. If you see an IBUxxx error, run `npx ibu explain IBUxxx`.
