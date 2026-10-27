import { createServer, logger, rateLimit, serveStatic, publicDir, sqliteDatabase, s, HttpError } from '@ibujs/server';
import { createAI } from '@ibujs/ai';

const app = createServer();
app.use(logger());
app.use(rateLimit({ limit: 300 })); // requests per minute per visitor

// A real database in a single file (data.db), created on first run. No install needed.
const db = await sqliteDatabase(process.env.DATABASE_FILE ?? 'data.db');
await db.raw(`CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

// Schemas check incoming data and give you TypeScript types for free.
const NewNote = s.object({ text: s.string({ min: 1, max: 500 }) });
const NoteId = s.number({ coerce: true, integer: true, min: 1 });

app.get('/api/notes', async ctx => {
  ctx.json(await db.sql`SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT 100`);
});

app.post('/api/notes', async ctx => {
  const { text } = await ctx.body(NewNote);
  const [note] = await db.sql`INSERT INTO notes (text) VALUES (${text}) RETURNING id, text, created_at`;
  ctx.json(note, 201);
});

app.delete('/api/notes/:id', async ctx => {
  const id = NoteId.parse(ctx.params.id);
  const deleted = await db.sql`DELETE FROM notes WHERE id = ${id} RETURNING id`;
  if (!deleted.length) throw new HttpError(404, 'Note not found');
  ctx.empty();
});

// AI answers stream to the page. The API key never leaves the server, and the route has
// built-in limits so a busy (or malicious) visitor cannot run up your bill.
const ai = process.env.ANTHROPIC_API_KEY
  ? createAI({ system: 'You are a friendly assistant inside a small notes app. Answer briefly and clearly.' })
  : null;
app.post('/api/ask', ai ? ai.route() : () => {
  throw new HttpError(503, 'AI is not set up yet: add ANTHROPIC_API_KEY to .env and restart the server.');
});

app.get('/api/health', ctx => ctx.json({ ok: true }));

// The browser app built by `ibu dev` / `ibu build`. spa: page URLs like /notes get index.html.
app.use(serveStatic(publicDir(), { spa: true }));

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
app.listen(port, host);
console.log(`IbuJS app ready at http://${host}:${port}`);
