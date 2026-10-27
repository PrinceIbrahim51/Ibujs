// Property-based fuzzing of the security-critical parsers with a seeded generator, so any failure
// can be reproduced. More runs: FUZZ_RUNS=50000 npm test. Different inputs: FUZZ_SEED=123.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { isSafeUrl, renderToString, h } from '../packages/ui/src/index.js';
import { createServer, parseCookies, createSessionManager, s, sql, toText, serveStatic, ValidationError } from '../packages/server/src/index.js';
import { withServer } from './helpers.js';

const RUNS = Number(process.env.FUZZ_RUNS ?? 3000);
const SEED = Number(process.env.FUZZ_SEED ?? 20261027);

// mulberry32: tiny, fast, deterministic.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rand = rng(SEED);
const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)];
const int = (max: number) => Math.floor(rand() * max);
const PIECES = ['javascript:', 'JaVaScRiPt:', 'java', 'script', ':', 'vbscript:', 'data:', 'text/html,', 'image/png;base64,', 'blob:', 'http:', 'https:', '//', '/', '\\', '..', '.', '%2e', '%2f', '%00', '%0a', '&#x3a;', '&colon;', '&#58;', '\t', '\n', '\r', '\x00', '\x01', '\x1f', ' ', ' ', ' ', '﻿', '?', '#', '@', 'evil.example', 'a', '<', '>', '"', "'", '`', '=', 'alert(1)', 'İ', 'ſ', 'ｊａｖａ'];
const fuzzString = (max = 8) => Array.from({ length: 1 + int(max) }, () => pick(PIECES)).join('');
const SAFE = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:']);

test(`URL sanitizer: nothing it allows has a dangerous scheme (${RUNS} inputs)`, () => {
  for (let i = 0; i < RUNS; i++) {
    const input = fuzzString();
    if (!isSafeUrl(input)) continue;
    const protocol = new URL(input, 'http://ibu.invalid/').protocol;
    assert.ok(SAFE.has(protocol), `allowed ${JSON.stringify(input)} with protocol ${protocol}`);
  }
});

test(`renderToString: text and attributes never break out (${RUNS} inputs)`, () => {
  const window = new Window();
  for (let i = 0; i < RUNS; i++) {
    const text = fuzzString(), title = fuzzString(), href = fuzzString();
    const html = renderToString(h('p', { title }, h('a', { href }, text))).toString();
    window.document.body.innerHTML = html;
    const p = window.document.body.firstElementChild!;
    assert.equal(window.document.body.children.length, 1, `markup injected by ${JSON.stringify([text, title])}`);
    assert.equal(p.children.length, 1);
    assert.equal(p.getAttribute('title'), title);
    assert.equal(p.textContent, text);
    const finalHref = p.firstElementChild!.getAttribute('href')!;
    assert.ok(finalHref === 'about:blank#blocked' || isSafeUrl(finalHref), `unsafe href survived: ${JSON.stringify(href)}`);
  }
});

test(`cookie parser: never throws, never touches prototypes (${RUNS} headers)`, () => {
  for (let i = 0; i < RUNS; i++) {
    const header = Array.from({ length: int(6) }, () => `${pick(['a', '__proto__', 'constructor', 'x y', '', '=', 'id'])}=${fuzzString(3)}`).join(pick([';', '; ', ',', '']));
    const cookies = parseCookies(header);
    assert.equal(Object.getPrototypeOf(cookies), null);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test(`session tokens: random and mutated tokens are rejected, never throw (${RUNS} tokens)`, () => {
  const sessions = createSessionManager({ secret: 'Fz9Qw2Er7Ty4Ui1Op6As3Df8Gh5Jk0Lz-xC' });
  const valid = sessions.issue('user-1');
  for (let i = 0; i < RUNS; i++) {
    const chars = [...valid];
    for (let n = 1 + int(3); n > 0; n--) chars[int(chars.length)] = pick([...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.=+/']);
    const mutated = chars.join('');
    if (mutated === valid) continue;
    assert.equal(sessions.verify(mutated), null, `accepted mutated token ${mutated}`);
    assert.equal(sessions.verify(fuzzString(12)), null);
  }
});

test(`schemas: hostile JSON either validates or fails cleanly (${RUNS} values)`, () => {
  const Body = s.object({ name: s.string({ max: 20 }), tags: s.array(s.string(), { max: 3 }).optional(), age: s.number({ integer: true }).optional() });
  const value = (depth: number): unknown => {
    const kind = int(depth > 2 ? 5 : 8);
    if (kind === 0) return fuzzString(3);
    if (kind === 1) return rand() * 1e6 - 5e5;
    if (kind === 2) return pick([null, true, false, NaN, Infinity, -0]);
    if (kind === 3) return Array.from({ length: int(5) }, () => value(depth + 1));
    if (kind === 4) return pick(['', 'x'.repeat(30), 'ok']);
    return Object.fromEntries(Array.from({ length: int(4) }, () => [pick(['name', 'tags', 'age', '__proto__', 'constructor', 'isAdmin']), value(depth + 1)]));
  };
  for (let i = 0; i < RUNS; i++) {
    const input = JSON.parse(JSON.stringify(value(0)) ?? 'null');
    try {
      const out = Body.parse(input);
      assert.deepEqual(Object.keys(out).filter(k => !['name', 'tags', 'age'].includes(k)), [], 'unknown keys dropped');
      assert.ok(out.name.length <= 20);
    } catch (err) {
      assert.ok(err instanceof ValidationError, `unexpected ${(err as Error).name}: ${(err as Error).message}`);
    }
  }
  assert.equal(({} as Record<string, unknown>).isAdmin, undefined);
});

test(`sql: placeholders always match values, however fragments nest (${RUNS} queries)`, () => {
  const build = (depth: number): ReturnType<typeof sql> => {
    const parts = int(4);
    const strings = Array.from({ length: parts + 1 }, () => pick(['SELECT ', ' WHERE x = ', ' AND ', '', " '?' ", ' $1 ']));
    const values = Array.from({ length: parts }, () => depth < 3 && rand() < 0.3 ? build(depth + 1) : fuzzString(2));
    return sql(strings, ...values);
  };
  for (let i = 0; i < RUNS; i++) {
    const query = build(0);
    assert.equal(toText(query).split('?').length - 1 - (toText(query).match(/'\?'/g)?.length ?? 0), query.values.length);
    assert.equal(query.strings.length, query.values.length + 1);
    for (const v of query.values) assert.equal(typeof v, 'string', 'values stay values, never SQL');
  }
});

test(`HTTP: hostile request lines and paths never crash the server or escape the static folder (${Math.min(RUNS, 400)} requests)`, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ibu-fuzz-'));
  await mkdir(join(dir, 'public'));
  await writeFile(join(dir, 'public', 'index.html'), 'PUBLIC');
  await writeFile(join(dir, 'secret.txt'), 'TOP-SECRET');
  const errors: unknown[] = [];
  const app = createServer({ onError: e => errors.push(e) });
  app.use(serveStatic(join(dir, 'public'), { spa: true }));
  app.get('/api/:id', ctx => ctx.json({ id: ctx.params.id }));
  try {
    await withServer(app, async base => {
      const { port } = new URL(base);
      for (let i = 0; i < Math.min(RUNS, 400); i++) {
        const path = pick(['/', '//', '/api/', '/..', '/%2e%2e/', '']) + fuzzString(6).replace(/[\r\n]/g, '');
        const raw = `${pick(['GET', 'POST', 'HEAD', 'PUT', 'DELETE', 'BREW'])} ${path} HTTP/1.1\r\nHost: x\r\nAccept: text/html\r\nConnection: close\r\n\r\n`;
        const response = await new Promise<string>(resolve => {
          const socket = net.connect(Number(port), '127.0.0.1', () => socket.end(raw));
          let data = '';
          socket.on('data', d => { data += d; }).on('close', () => resolve(data)).on('error', () => resolve(data));
        });
        assert.ok(!response.includes('TOP-SECRET'), `leaked a file outside the folder for ${JSON.stringify(path)}`);
        assert.ok(!/^HTTP\/1\.1 5\d\d/.test(response), `server error for ${JSON.stringify(raw.split('\r\n')[0])}: ${response.split('\r\n')[0]}`);
      }
      assert.equal((await fetch(base + '/api/ok')).status, 200, 'still serving after the fuzz run');
    });
    assert.deepEqual(errors, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
