// Runs the login example from docs/GUIDE.md as written, so the docs stay correct.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createSessionManager, hashPassword, verifyPassword, rateLimit, HttpError, s, sqliteDatabase } from '../packages/server/src/index.js';
import { withServer, json } from './helpers.js';

test('docs/GUIDE.md login example works end to end', async () => {
  process.env.SESSION_SECRET ??= 'Qm9vdHN0cmFwcGVkLXRlc3Qtc2VjcmV0LTEyMzQ1';
  const app = createServer();
  const db = await sqliteDatabase(':memory:');
  // --- from the guide ---
  const sessions = createSessionManager({ secret: process.env.SESSION_SECRET! });
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
    const session = await sessions.require(ctx);
    ctx.json({ id: session.sub });
  });
  // --- end ---

  await withServer(app, async base => {
    const creds = { email: 'Ada@Example.com', password: 'a long enough passphrase' };
    const signup = await fetch(base + '/api/signup', json(creds));
    assert.equal(signup.status, 201);
    assert.equal((await fetch(base + '/api/signup', json(creds))).status, 409);
    assert.equal((await fetch(base + '/api/signup', json({ ...creds, password: 'short' }))).status, 400);
    assert.equal((await fetch(base + '/api/login', json({ ...creds, password: 'the wrong passphrase' }))).status, 401);
    assert.equal((await fetch(base + '/api/login', json({ email: 'nobody@example.com', password: 'whatever passphrase' }))).status, 401);
    const login = await fetch(base + '/api/login', json({ email: 'ada@example.com', password: creds.password }));
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    assert.deepEqual(await (await fetch(base + '/api/me', { headers: { Cookie: cookie } })).json(), { id: '1' });
    assert.equal((await fetch(base + '/api/me')).status, 401);
  });
  await db.close();
});
