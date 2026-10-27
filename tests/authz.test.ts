import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createServer, createSessionManager, sqliteDatabase, definePolicy, owner, role, loggedIn, anyOf, allOf, actorFromSession, HttpError, s
} from '../packages/server/src/index.js';
import { withServer, json } from './helpers.js';

type Note = { id: number; owner_id: number; text: string; is_public: number };
const alice = { id: '1', roles: [] as string[] }, bob = { id: '2' }, admin = { id: '9', roles: ['admin'] };
const note: Note = { id: 10, owner_id: 1, text: 'hi', is_public: 0 };

test('policies: deny by default, owner/role/anyOf/allOf, async rules, filter', async () => {
  const notes = definePolicy<Note, 'read' | 'update' | 'delete' | 'publish'>({
    read: anyOf(owner('owner_id'), (_user, n) => n.is_public === 1),
    update: owner('owner_id'),
    delete: anyOf(owner('owner_id'), role('admin')),
    publish: allOf(loggedIn, async (user, n) => user?.id === String(n.owner_id))
  });
  assert.equal(await notes.can(alice, 'update', note), true, 'numeric owner id matches string actor id');
  assert.equal(await notes.can(bob, 'update', note), false);
  assert.equal(await notes.can(null, 'read', note), false);
  assert.equal(await notes.can(null, 'read', { ...note, is_public: 1 }), true);
  assert.equal(await notes.can(admin, 'delete', note), true);
  assert.equal(await notes.can(admin, 'update', note), false);
  assert.equal(await notes.can(alice, 'publish', note), true);
  assert.equal(await notes.can(alice, 'archive' as never, note), false, 'unknown actions are denied');
  assert.equal(await notes.can(alice, '__proto__' as never, note), false);
  const visible = await notes.filter(bob, 'read', [note, { ...note, id: 11, is_public: 1 }]);
  assert.deepEqual(visible.map(n => n.id), [11]);
  await assert.rejects(notes.authorize(null, 'update', note), (e: HttpError) => e.status === 401);
  await assert.rejects(notes.authorize(bob, 'update', note), (e: HttpError) => e.status === 403 && e.details?.code === 'IBU506');
  await assert.rejects(notes.authorize(bob, 'update', note, { hide: true }), (e: HttpError) => e.status === 404);
  await assert.rejects(notes.authorize(null, 'update', note, { hide: true }), (e: HttpError) => e.status === 404);
  await notes.authorize(alice, 'update', note);
  assert.throws(() => definePolicy({ read: 'yes' as never }), /IBU507/);
  assert.deepEqual(actorFromSession({ sub: '5', iat: 0, exp: 0, jti: 'x', data: { roles: 'admin, editor' } }), { id: '5', roles: ['admin', 'editor'] });
  assert.equal(actorFromSession(null), null);
});

test('IDOR scenario: a user cannot read, edit or delete another user\'s note', async () => {
  const app = createServer();
  const db = await sqliteDatabase(':memory:');
  await db.raw('CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL, text TEXT NOT NULL, is_public INTEGER NOT NULL DEFAULT 0)');
  const sessions = createSessionManager({ secret: 'Rz7Kq2Lm9Np4Xw8Vt1Ys6Hb3Jd5Fc0Ga-uE' });
  const notes = definePolicy<Note>({ read: anyOf(owner('owner_id'), (_u, n) => n.is_public === 1), update: owner('owner_id'), delete: anyOf(owner('owner_id'), role('admin')) });
  const NoteId = s.number({ coerce: true, integer: true, min: 1 });
  const load = async (id: number) => (await db.sql<Note>`SELECT * FROM notes WHERE id = ${id}`)[0];

  app.post('/login/:id', ctx => { sessions.login(ctx, ctx.params.id, ctx.params.id === '9' ? { roles: 'admin' } : undefined); ctx.empty(); });
  app.post('/api/notes', async ctx => {
    const user = actorFromSession(await sessions.require(ctx));
    const { text } = await ctx.body(s.object({ text: s.string({ min: 1 }) }));
    ctx.json((await db.sql`INSERT INTO notes (owner_id, text) VALUES (${Number(user!.id)}, ${text}) RETURNING *`)[0], 201);
  });
  app.get('/api/notes/:id', async ctx => {
    const note = await load(NoteId.parse(ctx.params.id));
    if (!note) throw new HttpError(404, 'Not found');
    await notes.authorize(actorFromSession(await sessions.get(ctx)), 'read', note, { hide: true });
    ctx.json(note);
  });
  app.put('/api/notes/:id', async ctx => {
    const note = await load(NoteId.parse(ctx.params.id));
    if (!note) throw new HttpError(404, 'Not found');
    await notes.authorize(actorFromSession(await sessions.get(ctx)), 'update', note);
    const { text } = await ctx.body(s.object({ text: s.string({ min: 1 }) }));
    ctx.json((await db.sql`UPDATE notes SET text = ${text} WHERE id = ${note.id} RETURNING *`)[0]);
  });
  app.delete('/api/notes/:id', async ctx => {
    const note = await load(NoteId.parse(ctx.params.id));
    if (!note) throw new HttpError(404, 'Not found');
    await notes.authorize(actorFromSession(await sessions.get(ctx)), 'delete', note);
    await db.sql`DELETE FROM notes WHERE id = ${note.id}`;
    ctx.empty();
  });

  await withServer(app, async base => {
    const cookieFor = async (id: string) => ((await fetch(`${base}/login/${id}`, { method: 'POST' })).headers.get('set-cookie') ?? '').split(';')[0];
    const [aliceCookie, bobCookie, adminCookie] = [await cookieFor('1'), await cookieFor('2'), await cookieFor('9')];
    const as = (cookie: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string> ?? {}), Cookie: cookie } });
    const created = await (await fetch(base + '/api/notes', as(aliceCookie, json({ text: 'alice private note' })))).json();
    const url = `${base}/api/notes/${created.id}`;

    assert.equal((await fetch(url, as(aliceCookie))).status, 200, 'owner can read');
    assert.equal((await fetch(url, as(bobCookie))).status, 404, 'others get 404, so ids cannot be probed');
    assert.equal((await fetch(url)).status, 404);
    const bobEdit = await fetch(url, as(bobCookie, { ...json({ text: 'hacked' }), method: 'PUT' }));
    assert.equal(bobEdit.status, 403);
    assert.equal((await bobEdit.json()).code, 'IBU506');
    assert.equal((await fetch(url, as(bobCookie, { method: 'DELETE' }))).status, 403);
    assert.equal((await fetch(url, { ...json({ text: 'x' }), method: 'PUT' })).status, 401);
    assert.equal((await (await fetch(url, as(aliceCookie))).json()).text, 'alice private note', 'unchanged');
    assert.equal((await fetch(url, as(adminCookie, { method: 'DELETE' }))).status, 204, 'admin may delete');
  });
  await db.close();
});
