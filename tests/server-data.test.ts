import { test } from 'node:test';
import assert from 'node:assert/strict';
import { s, validateObject, sql, toText, createDatabase, sqliteDatabase, memoryDatabase, ValidationError, type Infer } from '../packages/server/src/index.js';

test('schema: strings are trimmed and capped by default; unknown keys are dropped', () => {
  const User = s.object({ name: s.string({ min: 1, max: 5 }), email: s.string({ email: true }), site: s.string({ url: true }).optional(), age: s.number({ integer: true, min: 0 }).optional() });
  type User = Infer<typeof User>;
  const user: User = User.parse({ name: ' Ibu ', email: 'a@b.co', isAdmin: true });
  assert.deepEqual(user, { name: 'Ibu', email: 'a@b.co' });
  assert.equal(s.string().safeParse('x'.repeat(10_001)).ok, false);
  const result = User.safeParse({ name: '', email: 'nope', site: 'javascript:alert(1)', age: 1.5 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.issues.map(i => i.path), ['name', 'email', 'site', 'age']);
  assert.throws(() => s.object({ a: s.string() }, { strict: true }).parse({ a: 'x', b: 1 }), (e: ValidationError) => e.issues[0].path === 'b');
  assert.deepEqual(s.array(s.object({ id: s.id() }), { max: 2 }).safeParse([{ id: 'ok' }, { id: 'bad id' }]), { ok: false, issues: [{ path: '[1].id', message: 'has an invalid format' }] });
  assert.equal(s.number({ coerce: true }).parse('42'), 42);
  assert.equal(s.enum(['a', 'b']).safeParse('c').ok, false);
  assert.equal(s.boolean().default(false).parse(undefined), false);
  assert.throws(() => s.number().parse(NaN));
  // v0.5 compatibility
  assert.deepEqual(validateObject({ x: 'ok', admin: true }, { x: 'string' }), { x: 'ok' });
  assert.throws(() => validateObject({ x: 5 }, { x: 'string' }), ValidationError);
});

test('sql``: values never become query text', () => {
  const id = "1; DROP TABLE users; --";
  const q = sql`SELECT * FROM users WHERE id = ${id} AND role = ${'admin'}`;
  assert.equal(toText(q), 'SELECT * FROM users WHERE id = ? AND role = ?');
  assert.equal(toText(q, '$'), 'SELECT * FROM users WHERE id = $1 AND role = $2');
  assert.deepEqual(q.values, [id, 'admin']);
  const where = sql`owner = ${7}`;
  const composed = sql`SELECT * FROM notes WHERE ${where} ORDER BY ${sql.identifier('created_at')} LIMIT ${10}`;
  assert.equal(toText(composed, '$'), 'SELECT * FROM notes WHERE owner = $1 ORDER BY "created_at" LIMIT $2');
  assert.deepEqual(composed.values, [7, 10]);
  assert.equal(toText(sql`IN (${sql.join([sql`${1}`, sql`${2}`, sql`${3}`])})`), 'IN (?, ?, ?)');
  assert.throws(() => sql.identifier('name; DROP TABLE x'), /IBU601/);
});

test('createDatabase only accepts sql`` queries (plain strings need the explicit raw())', async () => {
  const calls: unknown[] = [];
  const db = createDatabase({ async query(text, params) { calls.push([text, params]); return []; }, async close() {}, placeholder: '$' });
  await db.sql`SELECT ${1}`;
  await assert.rejects(async () => db.query("SELECT * FROM users WHERE name = '" + 'x' + "'" as never), /IBU602/);
  await db.raw('SELECT $1', [2]);
  assert.deepEqual(calls, [['SELECT $1', [1]], ['SELECT $1', [2]]]);
});

test('sqliteDatabase: zero-install persistence, injection attempts are stored as plain text', async () => {
  const db = await sqliteDatabase(':memory:');
  await db.raw('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)');
  const evil = "x'); DROP TABLE notes; --";
  const [inserted] = await db.sql<{ id: number; text: string }>`INSERT INTO notes (text, done) VALUES (${evil}, ${true}) RETURNING id, text`;
  assert.equal(inserted.text, evil);
  const rows = await db.sql<{ text: string; done: number }>`SELECT text, done FROM notes WHERE id = ${inserted.id}`;
  assert.deepEqual(rows.map(r => ({ ...r })), [{ text: evil, done: 1 }]);
  const count = await db.sql<{ n: number }>`SELECT count(*) AS n FROM notes`;
  assert.equal(count[0].n, 1, 'table still exists');
  await db.close();
});

test('memoryDatabase: ids, copies, update and remove', () => {
  const db = memoryDatabase<{ text: string }>();
  const a = db.insert({ text: 'a' });
  db.insert({ text: 'b' });
  assert.equal(a.id, 1);
  a.text = 'mutated outside';
  assert.equal(db.find(1)?.text, 'a', 'returned rows are copies');
  assert.equal(db.update(1, { text: 'A' })?.text, 'A');
  assert.equal(db.remove(2), true);
  assert.deepEqual(db.all(), [{ text: 'A', id: 1 }]);
});
