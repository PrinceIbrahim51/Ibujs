import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, HttpError, s, html, renderPage, renderDocument, logger, IbuError } from '../packages/server/src/index.js';
import { withServer, rawRequest, json } from './helpers.js';

test('routing: exact, params, wildcard, 404, 405 with Allow, HEAD', async () => {
  const app = createServer();
  app.get('/hello', ctx => ctx.json({ ok: true }));
  app.get('/users/:id', ctx => ctx.json({ id: ctx.params.id }));
  app.get('/files/*', ctx => ctx.json({ rest: ctx.params['*'] }));
  app.post('/hello', ctx => ctx.json({ posted: true }, 201));
  await withServer(app, async base => {
    assert.deepEqual(await (await fetch(base + '/hello')).json(), { ok: true });
    assert.deepEqual(await (await fetch(base + '/users/hello%20world')).json(), { id: 'hello world' });
    assert.deepEqual(await (await fetch(base + '/files/a/b/c.txt')).json(), { rest: 'a/b/c.txt' });
    assert.equal((await fetch(base + '/users/%ZZ')).status, 404);
    const missing = await fetch(base + '/missing');
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).code, 'IBU404');
    const wrongMethod = await fetch(base + '/hello', { method: 'DELETE' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET, POST, HEAD');
    const head = await fetch(base + '/hello', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    // v0.5 matched the literal pattern text as a route.
    assert.equal((await (await fetch(base + '/users/:id')).json()).id, ':id');
  });
});

test('route definitions are validated', () => {
  const app = createServer();
  app.get('/a', ctx => ctx.json({}));
  assert.throws(() => app.get('/a', ctx => ctx.json({})), /IBU405.*defined twice/s);
  assert.throws(() => app.get('no-slash', ctx => ctx.json({})), /IBU405/);
});

test('route-level middleware runs before the handler', async () => {
  const app = createServer();
  const order: string[] = [];
  app.use(async (_ctx, next) => { order.push('global'); await next(); });
  app.post('/x', async (_ctx, next) => { order.push('route'); await next(); }, ctx => { order.push('handler'); ctx.json({}); });
  await withServer(app, async base => {
    await fetch(base + '/x', { method: 'POST' });
    assert.deepEqual(order, ['global', 'route', 'handler']);
  });
});

test('security headers on every response; HSTS only over (trusted) HTTPS', async () => {
  const app = createServer({ trustProxy: true });
  app.get('/x', ctx => ctx.json({ secure: ctx.secure, ip: ctx.ip }));
  await withServer(app, async base => {
    const res = await fetch(base + '/x');
    for (const [name, value] of Object.entries({
      'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'cross-origin-opener-policy': 'same-origin', 'cache-control': 'no-store'
    })) assert.equal(res.headers.get(name), value, name);
    assert.match(res.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
    assert.equal(res.headers.get('strict-transport-security'), null);
    const proxied = await fetch(base + '/x', { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9' } });
    assert.match(proxied.headers.get('strict-transport-security') ?? '', /max-age=31536000/);
    assert.deepEqual(await proxied.json(), { secure: true, ip: '203.0.113.9' });
  });
});

test('X-Forwarded-For is ignored unless trustProxy is set, and spoofed entries are skipped', async () => {
  const plain = createServer();
  plain.get('/ip', ctx => ctx.json({ ip: ctx.ip }));
  await withServer(plain, async base => {
    const res = await fetch(base + '/ip', { headers: { 'X-Forwarded-For': '1.2.3.4' } });
    assert.equal((await res.json()).ip, '127.0.0.1');
  });
  const proxied = createServer({ trustProxy: 1 });
  proxied.get('/ip', ctx => ctx.json({ ip: ctx.ip }));
  await withServer(proxied, async base => {
    // The client claims to be 6.6.6.6; the proxy appends the real address it saw.
    const res = await fetch(base + '/ip', { headers: { 'X-Forwarded-For': '6.6.6.6, 198.51.100.7' } });
    assert.equal((await res.json()).ip, '198.51.100.7');
  });
});

test('request targets cannot smuggle a different host or skip routing', async () => {
  const app = createServer();
  app.get('/api/hello', ctx => ctx.json({ hello: true }));
  await withServer(app, async base => {
    // v0.5 parsed "//evil.example/api/hello" as host evil.example + path /api/hello and served it.
    const doubleSlash = await rawRequest(base, { path: '//evil.example/api/hello' });
    assert.equal(doubleSlash.status, 404);
    const absolute = await rawRequest(base, { path: 'http://evil.example/api/hello' });
    assert.equal(absolute.status, 400);
    assert.match(absolute.body, /IBU413/);
  });
});

test('JSON bodies: content type, invalid JSON, size limits, parse once, prototype keys stripped', async () => {
  const app = createServer({ maxBodyBytes: 64 });
  app.post('/echo', async ctx => {
    const first = await ctx.body<Record<string, unknown>>();
    const second = await ctx.body();
    ctx.json({ first, same: first === second, proto: Object.getPrototypeOf(first) === Object.prototype, polluted: ({} as Record<string, unknown>).polluted ?? null });
  });
  await withServer(app, async base => {
    const ok = await fetch(base + '/echo', json({ a: 1 }));
    assert.deepEqual(await ok.json(), { first: { a: 1 }, same: true, proto: true, polluted: null });
    const evil = await fetch(base + '/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"__proto__":{"polluted":1},"b":2}' });
    assert.deepEqual((await evil.json()).first, { b: 2 });
    assert.equal((await fetch(base + '/echo', { method: 'POST', body: 'a=1', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
    const bad = await fetch(base + '/echo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).code, 'IBU403');
    const big = await fetch(base + '/echo', json({ x: 'a'.repeat(200) }));
    assert.equal(big.status, 413);
    // Chunked upload without Content-Length: rejected once it passes the limit, connection closed.
    const streamed = await rawRequest(base, { path: '/echo', method: 'POST', headers: { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }, chunks: Array.from({ length: 64 }, () => Buffer.alloc(16 * 1024, 'a')) });
    assert.equal(streamed.status, 413);
    assert.equal(streamed.headers.connection, 'close');
  });
});

test('ctx.body(schema) validates, strips unknown keys and returns typed data', async () => {
  const app = createServer();
  const NewNote = s.object({ text: s.string({ min: 1, max: 20 }), pinned: s.boolean().optional() });
  app.post('/notes', async ctx => {
    const note = await ctx.body(NewNote);
    const text: string = note.text;
    ctx.json({ note, length: text.length }, 201);
  });
  await withServer(app, async base => {
    const ok = await fetch(base + '/notes', json({ text: '  hi  ', isAdmin: true }));
    assert.equal(ok.status, 201);
    assert.deepEqual(await ok.json(), { note: { text: 'hi' }, length: 2 });
    const bad = await fetch(base + '/notes', json({ text: '', pinned: 'yes' }));
    assert.equal(bad.status, 400);
    const body = await bad.json();
    assert.equal(body.code, 'IBU415');
    assert.deepEqual(body.issues, [{ path: 'text', message: 'is required' }, { path: 'pinned', message: 'must be true or false' }]);
  });
});

test('errors: 4xx messages are shown, 5xx are hidden and logged, missing responses are caught', async () => {
  const logged: unknown[] = [];
  const app = createServer({ onError: err => logged.push(err) });
  app.get('/conflict', () => { throw new HttpError(409, 'Already exists', { code: 'APP1' }); });
  app.get('/crash', () => { throw new Error('database password is hunter2'); });
  app.get('/legacy', () => { throw Object.assign(new Error('Legacy 422'), { status: 422 }); });
  app.get('/forgot', () => { /* no response */ });
  await withServer(app, async base => {
    const conflict = await fetch(base + '/conflict');
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'Already exists', code: 'APP1' });
    const crash = await fetch(base + '/crash');
    assert.equal(crash.status, 500);
    const crashBody = await crash.json();
    assert.equal(crashBody.error, 'Internal server error');
    assert.equal(JSON.stringify(crashBody).includes('hunter2'), false);
    assert.equal(crashBody.requestId, crash.headers.get('x-request-id'));
    assert.equal((await fetch(base + '/legacy')).status, 422);
    const forgot = await fetch(base + '/forgot');
    assert.equal(forgot.status, 500);
  });
  assert.equal(logged.length, 2);
  assert.match(String((logged[1] as Error).message), /IBU410/);
});

test('dev mode adds debug details to 500 responses', async () => {
  const app = createServer({ dev: true, onError: () => {} });
  app.get('/crash', () => { throw new Error('boom'); });
  await withServer(app, async base => {
    assert.equal((await (await fetch(base + '/crash')).json()).debug, 'boom');
  });
});

test('redirects are same-site only unless explicitly allowed', async () => {
  const app = createServer({ onError: () => {} });
  app.get('/go', ctx => ctx.redirect(ctx.query.get('to') ?? '/'));
  app.get('/out', ctx => ctx.redirect('https://example.com/', { allowExternal: true }));
  await withServer(app, async base => {
    const ok = await fetch(base + '/go?to=/dashboard', { redirect: 'manual' });
    assert.equal(ok.status, 302);
    assert.equal(ok.headers.get('location'), '/dashboard');
    for (const target of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      const res = await fetch(base + '/go?to=' + encodeURIComponent(target), { redirect: 'manual' });
      assert.equal(res.status, 500, target);
      assert.equal(res.headers.get('location'), null, target);
    }
    assert.equal((await fetch(base + '/out', { redirect: 'manual' })).headers.get('location'), 'https://example.com/');
  });
});

test('HTML responses must be escaped HTML and get the page CSP', async () => {
  const app = createServer({ onError: () => {} });
  app.get('/page', ctx => ctx.html(renderPage({ title: 'Hi <b>', body: '<script>alert(1)</script>', scripts: ['/app.js'] })));
  app.get('/raw', ctx => ctx.html('<p>raw</p>' as never));
  await withServer(app, async base => {
    const page = await fetch(base + '/page');
    const text = await page.text();
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.match(text, /<title>Hi &lt;b&gt;<\/title>/);
    assert.match(text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(text, /<script type="module" src="\/app.js"><\/script>/);
    assert.equal((await fetch(base + '/raw')).status, 500);
  });
});

test('renderPage/renderDocument/html escape by default', () => {
  const name = '"><img src=x onerror=alert(1)>';
  assert.equal(html`<p title="${name}">${name}</p>`.toString(), '<p title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">&quot;&gt;&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.match(renderDocument('t', '<script>x</script>').toString(), /&lt;script&gt;/);
  assert.match(renderDocument('t', html`<b>ok</b>`).toString(), /<b>ok<\/b>/);
  assert.throws(() => renderPage({ title: 't', scripts: ['javascript:alert(1)'] }), IbuError);
});

test('logger never logs query strings', async () => {
  const lines: string[] = [];
  const app = createServer();
  app.use(logger({ log: line => lines.push(line) }));
  app.get('/reset', ctx => ctx.json({}));
  app.post('/fail', () => { throw new HttpError(422, 'nope'); });
  await withServer(app, async base => {
    await fetch(base + '/reset?token=secret123');
    await fetch(base + '/fail', { method: 'POST' });
    await new Promise(r => setTimeout(r, 20));
  });
  assert.match(lines[0], /^GET \/reset 200 \d+ms [0-9a-f-]{36}$/);
  assert.match(lines[1], /^POST \/fail 422 /, 'logs the final status of handled errors');
});
