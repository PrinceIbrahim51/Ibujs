# AI in IbuJS

IbuJS uses AI at three levels: AI that **writes** your code, AI that **teaches and reviews**, and AI **features inside your app**. All of them use Claude (`claude-opus-5-5`) through the official Anthropic SDK, with server-side refusal fallback enabled (`fallbacks: "default"`).

Setup for all AI features: create a key at https://platform.claude.com and add it to `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

`.env` is git-ignored. The CLI loads it automatically. Never put the key in code (`npx ibu check` flags it).

## 1. AI that writes your code

```bash
npx ibu ai "add a page that lists my notes with a delete button"
npx ibu ai "add login with email and password" --dry-run      # show the code, write nothing
npx ibu ai "make the notes searchable" --yes --effort=xhigh    # apply without asking; think harder
```

How it works:

1. Collects your app's source files (`src/`, `index.html`, config; max 200 KB) plus `llms.txt` (the framework reference) and `AGENTS.md` (your project rules). The reference is prompt-cached, so repeated runs are cheaper and faster.
2. Asks Claude for a structured JSON plan (summary, complete files, notes for you), streamed with a progress counter.
3. **Checks every file before writing:**
   - Paths must stay inside the project. Dotfiles (`.env`, `.github/`), `package.json` and lockfiles, `packages/`, `node_modules/` and non-source extensions are refused (`IBU903`).
   - Each file runs through the same security lint as `ibu check`; any error blocks the whole change.
   - If any part of the plan is rejected, nothing is written.
4. Shows new/modified files with line counts and asks before writing (or `--yes`; in CI without a terminal it never writes without `--yes`).

Afterwards, review with `git diff`, then `npm run dev`. Because AI coding tools also read files from your repo, a malicious file in a cloned project could steer the AI ("prompt injection"). The checks above limit the damage, but *you* approve what runs.

**Other assistants** (Claude Code, Cursor, Copilot, Codex, Windsurf) automatically read `AGENTS.md` / `CLAUDE.md` in every IbuJS app, which point them to `llms.txt` and the security rules. They then write idiomatic, safe IbuJS code and run `npx ibu check` before finishing.

## 2. AI that teaches and reviews

```bash
npx ibu explain IBU412                     # offline: why it happened and how to fix it
npx ibu explain "paste any error here" --ai --file=src/server.ts   # tailored explanation using your code
npx ibu explain --list                     # every error code
npx ibu review                             # AI security + bug review of your app
npx ibu review src/server.ts               # review specific files
```

`ibu review` sends your files and the offline `ibu check` findings to Claude with a reviewer prompt that ranks real problems by severity and gives fixes in IbuJS terms. It never writes files.

## 3. AI features in your app (`@ibujs/ai`)

Server (`src/server.ts`):

```ts
import { createAI } from '@ibujs/ai';

const ai = createAI({ system: 'You are a friendly cooking assistant. Answer briefly.' });
app.post('/api/ask', ai.route());                    // streaming chat endpoint

// Or use it inside your own routes:
app.post('/api/notes/:id/summary', async ctx => {
  const [note] = await db.sql`SELECT text FROM notes WHERE id = ${id}`;
  ctx.json({ summary: await ai.ask(`Summarise in one sentence:\n\n${note.text}`) });
});
```

Browser (`src/main.tsx`):

```tsx
const answer = signal('');
for await (const chunk of api.stream('/api/ask', { prompt: question.value })) answer.value += chunk;
// <p>{answer}</p> renders as text, so model output can never inject HTML or scripts.
```

What `ai.route()` protects you from:

| Risk | Protection |
|---|---|
| API key stolen from the page | The key only exists on the server; importing `@ibujs/ai` in browser code fails the build (`IBU702`) and throws at runtime (`IBU801`). |
| Someone runs up your bill | 10 requests/minute per visitor, 4 concurrent requests, 4,000-character inputs, 20-message histories, 4,096 output tokens (all configurable). |
| Paying for answers nobody reads | The Claude request is cancelled when the visitor disconnects. |
| Prompt override | Clients can only send `user`/`assistant` messages; the system prompt is fixed on the server. |
| XSS through AI output | Answers are plain text, and IbuJS renders text safely. |
| Safety refusals | Server-side fallback retries on Anthropic's recommended model; a final refusal adds a clear notice to the answer. |

Options: `createAI({ model, system, effort, maxTokens, apiKey, client })`; `ai.route({ system, effort, maxTokens, maxInputChars, maxMessages, requestsPerMinute, maxConcurrent })`.

Conversation history sent by the browser can be edited by the user. If your app depends on the history being genuine (for example, a tutor that grades answers), store it on the server.
