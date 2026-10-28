import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
// @ts-expect-error plain JavaScript module without type declarations
import { scanSource, RULES } from '../packages/cli/src/check.mjs';
// @ts-expect-error plain JavaScript module without type declarations
import { checkTarget } from '../packages/cli/src/ai.mjs';

type Finding = { rule: string };
const rulesIn = (code: string, file: string) => (scanSource(code, file) as Finding[]).map(f => f.rule);

test('every security rule fires on the mistake it targets', () => {
  const server = 'src/server.ts';
  const client = 'src/main.tsx';
  const cases: Array<[string, string, string]> = [
    ['IBU701', server, "const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwx';"],
    ['IBU701', server, "const config = { apiKey: 'AbC123xYz987QwErTy' };"],
    ['IBU702', client, 'const key = process.env.ANTHROPIC_API_KEY;'],
    ['IBU702', client, "import { createAI } from '@ibumomujs/ai';"],
    ['IBU703', client, 'el.innerHTML = comment;'],
    ['IBU704', server, 'const result = eval(userInput);'],
    ['IBU704', client, "setTimeout('refresh()', 100);"],
    ['IBU705', server, 'await db.raw(`SELECT * FROM users WHERE id = ${id}`);'],
    ['IBU705', server, "await db.raw('SELECT * FROM users WHERE name = ' + name);"],
    ['IBU705', server, 'const q = `DELETE FROM notes WHERE id = ${id}`;'],
    ['IBU706', server, 'exec(`convert ${file} out.png`);'],
    ['IBU707', server, 'const data = await readFile(join(dir, ctx.params.name));'],
    ['IBU708', server, 'const body = await ctx.body();'],
    ['IBU709', server, "ctx.redirect(next, { allowExternal: true });"],
    ['IBU710', server, 'const token = Math.random().toString(36);'],
    ['IBU711', server, "createHash('md5').update(password);"],
    ['IBU712', server, 'const app = createServer({ csrf: false });'],
    ['IBU713', server, "createServer({ cors: { origins: ['*'] } });"],
    ['IBU714', client, 'notes.value.push(note);'],
    ['IBU716', server, "createSessionManager('my-long-session-secret-value-here-123');"]
  ];
  for (const [rule, file, code] of cases) assert.ok(rulesIn(code, file).includes(rule), `${rule} should flag: ${code}`);
  const covered = new Set(cases.map(c => c[0]));
  for (const rule of RULES as Array<{ id: string }>) assert.ok(covered.has(rule.id), `${rule.id} has a test case`);
});

test('correct IbuJS code produces no findings', async () => {
  const good = [
    ['src/server.ts', "const rows = await db.sql`SELECT * FROM notes WHERE id = ${id}`;"],
    ['src/server.ts', 'const { text } = await ctx.body(NewNote);'],
    ['src/server.ts', 'const sessions = createSessionManager({ secret: process.env.SESSION_SECRET! });'],
    ['src/server.ts', "await db.raw(`CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY)`);"],
    ['src/main.tsx', 'notes.update(list => [...list, note]);'],
    ['src/main.tsx', 'await api.get(`/api/notes/${id}`);'],
    ['src/main.tsx', "<input type=\"password\" placeholder=\"Choose a strong password\" />"],
    ['src/server.ts', 'const x = Math.random(); // ibu-ignore IBU710 (shuffling a demo list)']
  ];
  for (const [file, code] of good) assert.deepEqual(rulesIn(code, file), [], code);
  for (const file of ['packages/cli/template/src/server.ts', 'packages/cli/template/src/main.tsx']) {
    assert.deepEqual(scanSource(await readFile(file, 'utf8'), file.replace('packages/cli/template/', '')), [], file);
  }
});

test('AI output may only write ordinary source files inside the project', () => {
  const root = '/home/me/app';
  for (const ok of ['src/main.tsx', 'src/pages/notes.tsx', 'index.html', 'src/style.css', 'README.md']) assert.equal(checkTarget(root, ok), null, ok);
  for (const bad of ['../x.ts', '/etc/passwd', 'C:/x.ts', 'src\\..\\..\\x.ts', '.env', 'src/.env.local', '.github/workflows/ci.yml', 'node_modules/x/index.js', 'packages/ui/src/index.ts', 'package.json', 'src/run.sh', 'src/a\0.ts', '', 'src/../../x.ts']) {
    assert.notEqual(checkTarget(root, bad), null, bad);
  }
});

test('ibu create: a random secret that stays out of git and Vercel uploads', async () => {
  // @ts-expect-error plain JavaScript module without type declarations
  const { create } = await import('../packages/cli/src/create.mjs');
  const { mkdtemp, stat, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'ibu-create-'));
  const log = console.log;
  console.log = () => {};
  try { await create('app', dir, { mode: 'npm' }); } finally { console.log = log; }
  const app = join(dir, 'app');
  const read = (file: string) => readFile(join(app, file), 'utf8');
  assert.match(await read('.env'), /SESSION_SECRET=\S{32,}/);
  if (process.platform !== 'win32') assert.equal((await stat(join(app, '.env'))).mode & 0o777, 0o600);
  for (const ignore of ['.gitignore', '.vercelignore']) assert.match(await read(ignore), /^\.env$/m, ignore);
  assert.deepEqual(JSON.parse(await read('vercel.json')), { framework: null, buildCommand: 'npm run build:vercel' });
  const pkg = JSON.parse(await read('package.json'));
  assert.equal(pkg.scripts['build:vercel'], 'ibu build --target=vercel');
  assert.match(pkg.dependencies['@ibumomujs/ui'], /^\^\d+\.\d+\.\d+$/);
  await rm(dir, { recursive: true, force: true });
});
