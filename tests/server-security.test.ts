import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scryptSync, randomBytes } from 'node:crypto';
import {
  createServer, rateLimit, rateLimitKey, parseCookies, serializeCookie, hashPassword, verifyPassword, needsRehash,
  createSessionManager, serveStatic, HttpError
} from '../packages/server/src/index.js';
import { withServer, rawRequest } from './helpers.js';

const SECRET = 'k3Jq9vX2mP8wR5tY7uZ1aB4cD6eF0gH-iL';

test('CSRF: cross-site browser writes are blocked, same-origin and non-browser clients are not', async () => {
  const app = createServer();
  app.post('/transfer', ctx => ctx.json({ ok: true }));
  app.get('/transfer', ctx => ctx.json({ read: true }));
  await withServer(app, async base => {
    const host = new URL(base).host;
    const post = (headers: Record<string, string>) => fetch(base + '/transfer', { method: 'POST', headers });
    assert.equal((await post({})).status, 200, 'curl/server-to-server');
    assert.equal((await post({ 'Sec-Fetch-Site': 'same-origin', Origin: base })).status, 200);
    assert.equal((await post({ 'Sec-Fetch-Site': 'none' })).status, 200, 'typed URL / bookmark');
    const cross = await post({ 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' });
    assert.equal(cross.status, 403);
    assert.equal((await cross.json()).code, 'IBU412');
    assert.equal((await post({ 'Sec-Fetch-Site': 'same-site', Origin: 'https://sub.' + host })).status, 403, 'sibling subdomain');
    assert.equal((await post({ Origin: 'https://evil.example' })).status, 403, 'older browser, Origin only');
    assert.equal((await post({ Origin: `http://${host}` })).status, 200, 'older browser, same host');
    assert.equal((await fetch(base + '/transfer', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 200, 'GET is not affected');
  });
  const trusting = createServer({ csrf: { trustedOrigins: ['https://admin.example'] } });
  trusting.post('/x', ctx => ctx.json({}));
  await withServer(trusting, async base => {
    assert.equal((await fetch(base + '/x', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://admin.example' } })).status, 200);
  });
});

test('CORS: only listed origins, credentials never with "*"', async () => {
  assert.throws(() => createServer({ cors: { origins: ['*'], credentials: true } }), /IBU406/);
  const app = createServer({ cors: { origins: ['https://app.example'], credentials: true } });
  app.post('/data', ctx => ctx.json({ ok: true }));
  await withServer(app, async base => {
    const preflight = await fetch(base + '/data', { method: 'OPTIONS', headers: { Origin: 'https://app.example', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example');
    assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
    const allowed = await fetch(base + '/data', { method: 'POST', headers: { Origin: 'https://app.example', 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(allowed.status, 200, 'CORS origins are trusted by CSRF protection');
    const other = await fetch(base + '/data', { method: 'POST', headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(other.status, 403);
    assert.equal(other.headers.get('access-control-allow-origin'), null);
  });
});

test('rate limiting: 429 with headers, IPv6 grouped per /64, memory capped', async () => {
  const app = createServer();
  app.use(rateLimit({ limit: 2 }));
  app.get('/x', ctx => ctx.json({}));
  await withServer(app, async base => {
    const first = await fetch(base + '/x');
    assert.equal(first.headers.get('ratelimit-remaining'), '1');
    await fetch(base + '/x');
    const third = await fetch(base + '/x');
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get('retry-after')) > 0);
    assert.equal((await third.json()).code, 'IBU416');
  });
  assert.equal(rateLimitKey('2001:db8:abcd:12:1::5'), '2001:db8:abcd:12::/64');
  assert.equal(rateLimitKey('2001:db8:abcd:12:ffff:ffff:ffff:ffff'), '2001:db8:abcd:12::/64');
  assert.equal(rateLimitKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.equal(rateLimitKey('::ffff:192.0.2.1'), '192.0.2.1');
  assert.equal(rateLimitKey('192.0.2.1'), '192.0.2.1');
  // Many distinct clients cannot grow memory without bound.
  const limiter = rateLimit({ limit: 1, maxKeys: 100, key: ctx => ctx.ip });
  const ctxFor = (ip: string) => ({ ip, res: { setHeader() {} } }) as never;
  for (let i = 0; i < 1000; i++) await limiter(ctxFor('10.0.' + Math.floor(i / 256) + '.' + (i % 256)), async () => {});
  // The very first client was evicted, so it is allowed again rather than tracked forever.
  await limiter(ctxFor('10.0.0.0'), async () => {});
});

test('cookies: parsing is prototype-safe, serialising enforces secure combinations', () => {
  const parsed = parseCookies('a=1; __proto__=x; constructor=y; a=2; bad name=3; enc=%F0%9F%8D%AA');
  assert.equal(Object.getPrototypeOf(parsed), null);
  assert.equal(parsed.a, '1');
  assert.equal(parsed.__proto__, 'x');
  assert.equal(parsed.enc, '🍪');
  assert.equal(serializeCookie('sid', 'a b'), 'sid=a%20b; Path=/; SameSite=Lax; HttpOnly');
  assert.throws(() => serializeCookie('sid', 'x', { sameSite: 'None' }), /IBU505/);
  assert.throws(() => serializeCookie('__Host-sid', 'x', { secure: false }), /IBU505/);
  assert.throws(() => serializeCookie('bad;name', 'x'), /IBU505/);
});

test('passwords: async scrypt, policy, v0.5 hashes still verify, timing-safe for unknown users', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^\$scrypt\$n=32768,r=8,p=3\$/);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password!!', hash), false);
  assert.equal(needsRehash(hash), false);
  await assert.rejects(hashPassword('short'), (e: HttpError) => e.status === 400 && /12 characters/.test(e.message));
  await assert.rejects(hashPassword('x'.repeat(2000)), (e: HttpError) => e.status === 400);
  assert.equal(await verifyPassword('anything at all', null), false);
  assert.equal(await verifyPassword('anything at all', 'garbage'), false);
  assert.equal(await verifyPassword('anything at all', '$scrypt$n=1073741824,r=8,p=1$AAAA$AAAA'), false, 'refuses absurd cost parameters');
  // A hash written by v0.5 (hex salt:hex hash, Node defaults).
  const salt = randomBytes(16);
  const legacy = salt.toString('hex') + ':' + scryptSync('old password 123', salt, 64).toString('hex');
  assert.equal(await verifyPassword('old password 123', legacy), true);
  assert.equal(needsRehash(legacy), true);
  // Hashing no longer blocks the event loop.
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  await hashPassword('another long password');
  clearInterval(timer);
  assert.ok(ticks > 0, 'timers kept running while hashing');
});

test('sessions: signed, tamper-proof, expiring, rotatable, revocable', async () => {
  assert.throws(() => createSessionManager('too-short'), /IBU501/);
  assert.throws(() => createSessionManager('change-me-change-me-change-me-change-me'), /IBU501/);
  assert.throws(() => createSessionManager('a'.repeat(40)), /IBU501/);
  const sessions = createSessionManager({ secret: SECRET, ttlSeconds: 60 });
  const token = sessions.issue('user-1', { role: 'member' });
  const session = sessions.verify(token);
  assert.equal(session?.sub, 'user-1');
  assert.deepEqual(session?.data, { role: 'member' });
  const [v, payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: 'admin' })).toString('base64url');
  assert.equal(sessions.verify(`${v}.${forged}.${sig}`), null, 'payload tampering');
  assert.equal(sessions.verify(`${v}.${payload}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`), null, 'signature tampering');
  assert.equal(sessions.verify('x'.repeat(5000)), null);
  assert.equal(sessions.verify(42), null);
  const expired = createSessionManager({ secret: SECRET, ttlSeconds: -1 }).issue('u');
  assert.equal(sessions.verify(expired), null);
  // Key rotation: new secret signs, old one still verifies existing sessions.
  const rotated = createSessionManager({ secret: ['Zx8Lm2Nq4Rs6Tu8Vw0Xy2Za4Bc6De8Fg0Hi', SECRET] });
  assert.equal(rotated.verify(token)?.sub, 'user-1');
  assert.equal(sessions.verify(rotated.issue('user-2')), null);

  const revoked = new Set<string>();
  const live = createSessionManager({ secret: SECRET, isRevoked: s => revoked.has(s.jti) });
  const app = createServer({ trustProxy: true });
  app.post('/login', ctx => { live.login(ctx, 'user-9'); ctx.json({}); });
  app.post('/logout', ctx => { live.logout(ctx); ctx.json({}); });
  app.get('/me', async ctx => { const s = await live.require(ctx); ctx.json({ id: s.sub, jti: s.jti }); });
  await withServer(app, async base => {
    const login = await fetch(base + '/login', { method: 'POST' });
    const cookie = login.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^ibu_session=v1\.[\w-]+\.[\w-]+; Path=\/; SameSite=Lax; Max-Age=3600; HttpOnly$/);
    const secureLogin = await fetch(base + '/login', { method: 'POST', headers: { 'X-Forwarded-Proto': 'https' } });
    assert.match(secureLogin.headers.get('set-cookie') ?? '', /^__Host-ibu_session=.*; HttpOnly; Secure$/);
    const jar = cookie.split(';')[0];
    const me = await fetch(base + '/me', { headers: { Cookie: jar } });
    const meBody = await me.json();
    assert.equal(meBody.id, 'user-9');
    assert.equal((await fetch(base + '/me')).status, 401);
    revoked.add(meBody.jti);
    assert.equal((await fetch(base + '/me', { headers: { Cookie: jar } })).status, 401, 'revoked');
    const logout = await fetch(base + '/logout', { method: 'POST' });
    assert.match(logout.headers.get('set-cookie') ?? '', /^ibu_session=; Path=\/; SameSite=Lax; Max-Age=0; HttpOnly$/);
  });
});

test('static files: types, caching, HEAD, SPA fallback, and no way out of the folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ibu-static-'));
  const root = join(dir, 'public');
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<!doctype html><p>home</p>');
  await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(join(root, '.env'), 'SECRET=1');
  await writeFile(join(dir, 'secret.txt'), 'top secret');
  await symlink(join(dir, 'secret.txt'), join(root, 'link.txt'));
  const app = createServer();
  app.use(serveStatic(root, { spa: true }));
  app.get('/api/x', ctx => ctx.json({ api: true }));
  try {
    await withServer(app, async base => {
      const js = await fetch(base + '/assets/app.js');
      assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assert.equal(await js.text(), 'console.log(1)');
      const etag = js.headers.get('etag')!;
      assert.equal((await fetch(base + '/assets/app.js', { headers: { 'If-None-Match': etag } })).status, 304);
      const head = await fetch(base + '/assets/app.js', { method: 'HEAD' });
      assert.equal(head.headers.get('content-length'), '14');
      const home = await fetch(base + '/');
      assert.match(home.headers.get('content-security-policy') ?? '', /script-src 'self'/);
      assert.match(await (await fetch(base + '/notes/42', { headers: { Accept: 'text/html' } })).text(), /home/);
      assert.equal((await fetch(base + '/notes/42', { headers: { Accept: 'application/json' } })).status, 404);
      assert.equal((await fetch(base + '/missing.png', { headers: { Accept: 'text/html' } })).status, 404);
      assert.deepEqual(await (await fetch(base + '/api/x')).json(), { api: true });
      for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/.env', '/%2eenv', '/link.txt', '/index.html%00.js', '/..%5csecret.txt']) {
        const res = await rawRequest(base, { path });
        assert.equal(res.status, 404, path);
        assert.ok(!res.body.includes('top secret') && !res.body.includes('SECRET=1'), path);
      }
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
