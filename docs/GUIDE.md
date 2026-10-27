# Beginner guide: your first IbuJS app

You need [Node.js 22.13 or newer](https://nodejs.org) (LTS) and a terminal.

## 1. Create and run

```bash
npx ibu create my-app      # from this repository: node packages/cli/src/cli.mjs create my-app
cd my-app
npm install
npm run dev
```

Open http://127.0.0.1:3000. You have a counter, notes saved in a database, and an "Ask AI" page. Edit `src/main.tsx` and the page rebuilds; edit `src/server.ts` and the server restarts.

## 2. How the pieces fit

```
src/main.tsx    → runs in the browser (what users see)
src/server.ts   → runs on your computer/server (data, secrets, AI)
index.html      → the page shell
.env            → secrets (never commit or share)
```

The page talks to the server with `api.get('/api/notes')`, `api.post('/api/notes', { text })`, and so on.

## 3. State that updates the page: signals

```tsx
import { signal, computed } from '@ibujs/ui';

const name = signal('');
const greeting = computed(() => name.value ? `Hello, ${name.value}!` : 'Type your name');

function Greeter() {
  return (
    <div>
      <input bind={name} placeholder="Your name" />
      <p>{greeting}</p>
    </div>
  );
}
```

Anything that reads `.value` (or renders `{signal}`) updates by itself when the value changes. For lists, make a new array: `todos.update(list => [...list, todo])`.

## 4. Add an API route

```ts
// src/server.ts
const NewTodo = s.object({ title: s.string({ min: 1, max: 100 }) });

app.post('/api/todos', async ctx => {
  const { title } = await ctx.body(NewTodo);   // rejects bad input with a clear 400
  const [todo] = await db.sql`INSERT INTO todos (title) VALUES (${title}) RETURNING *`;
  ctx.json(todo, 201);
});
```

Create the table once at startup: `await db.raw('CREATE TABLE IF NOT EXISTS todos (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL)')`.

## 5. Add login

```ts
import { createSessionManager, hashPassword, verifyPassword, rateLimit, HttpError, s } from '@ibujs/server';

const sessions = createSessionManager({ secret: process.env.SESSION_SECRET! });  // already in .env
await db.raw('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)');
const Credentials = s.object({ email: s.string({ email: true }), password: s.string({ min: 12, max: 200, trim: false }) });

app.post('/api/signup', rateLimit({ limit: 5 }), async ctx => {
  const { email, password } = await ctx.body(Credentials);
  const hash = await hashPassword(password);
  const [user] = await db.sql<{ id: number }>`INSERT INTO users (email, password_hash) VALUES (${email.toLowerCase()}, ${hash}) ON CONFLICT DO NOTHING RETURNING id`;
  if (!user) throw new HttpError(409, 'That email is already registered');
  sessions.login(ctx, String(user.id));
  ctx.json({ ok: true }, 201);
});

app.post('/api/login', rateLimit({ limit: 5 }), async ctx => {
  const { email, password } = await ctx.body(Credentials);
  const [user] = await db.sql<{ id: number; password_hash: string }>`SELECT id, password_hash FROM users WHERE email = ${email.toLowerCase()}`;
  if (!await verifyPassword(password, user?.password_hash)) throw new HttpError(401, 'Wrong email or password');
  sessions.login(ctx, String(user!.id));
  ctx.json({ ok: true });
});

app.post('/api/logout', ctx => { sessions.logout(ctx); ctx.empty(); });

app.get('/api/me', async ctx => {
  const session = await sessions.require(ctx);   // 401 if not logged in
  ctx.json({ id: session.sub });
});
```

On protected data, always filter by the logged-in user: `WHERE owner_id = ${session.sub}`. Sessions identify *who* someone is; you decide *what* they may touch.

## 6. Ask the AI to do it for you

```bash
npx ibu ai "add a todo list page with add, complete and delete, saved in the database"
```

You'll see the planned changes and approve them. See [AI.md](AI.md).

## 7. Check, build and deploy

```bash
npm run check        # security check (also run by `npx ibu doctor`)
npm run build        # creates dist/
npm start            # runs dist/server.mjs with NODE_ENV=production
```

Deploy `dist/` with `node dist/server.mjs` on any Node 22+ host:

1. Set the environment variables from `.env` in your host's dashboard.
2. Behind a proxy or load balancer, use `createServer({ trustProxy: true })` so rate limits and secure cookies work.
3. Set `HOST=0.0.0.0` only inside containers.

## When something breaks

Every IbuJS error has a code like `IBU415`. Run `npx ibu explain IBU415`, or `npx ibu explain "<the whole error>" --ai`. `npx ibu doctor` checks your setup.
