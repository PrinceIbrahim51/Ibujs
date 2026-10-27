import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import {
  h, isVNode, signal, computed, effect, batch, resource, createApp, nextTick, createRouter, matchRoute, renderToString,
  html, SafeHtml, isSafeUrl, api, onSecurityViolation, classNames, type SecurityViolation
} from '../packages/ui/src/index.js';

const window = new Window({ url: 'http://localhost:3000/' });
Object.assign(globalThis as Record<string, unknown>, { window, document: window.document, location: window.location, history: window.history });
const newRoot = () => { const el = document.createElement('div'); document.body.append(el); return el; };

test('elements are branded, so JSON lookalikes are never treated as elements', () => {
  const el = h('h1', { className: 'hi' }, 'Hello');
  assert.equal(el.type, 'h1');
  assert.deepEqual(el.props, { className: 'hi', children: ['Hello'] });
  assert.equal(isVNode(el), true);
  assert.equal(isVNode(JSON.parse(JSON.stringify(el))), false);
  assert.equal(isVNode(<p>jsx</p>), true);
});

test('signals: subscribe/unsubscribe, update helper, computed, batch', () => {
  const count = signal(0);
  let calls = 0;
  const unsubscribe = count.subscribe(() => calls++);
  count.value = 1; count.value = 1;
  assert.equal(calls, 1);
  unsubscribe();
  count.value = 2;
  assert.equal(calls, 1);
  const list = signal([1]);
  list.update(l => [...l, 2]);
  assert.deepEqual(list.value, [1, 2]);
  let computeRuns = 0;
  const doubled = computed(() => { computeRuns++; return count.value * 2; });
  assert.equal(doubled.value, 4);
  assert.equal(doubled.value, 4);
  assert.equal(computeRuns, 1, 'cached until a dependency changes');
  const a = signal(1), b = signal(2);
  let effectRuns = 0;
  const sum = computed(() => a.value + b.value);
  const stop = effect(() => { effectRuns++; void sum.value; });
  batch(() => { a.value = 10; b.value = 20; assert.equal(sum.value, 30, 'reads inside batch are fresh'); });
  assert.equal(effectRuns, 2, 'one run for the initial call, one for the whole batch');
  stop();
});

test('effect: auto-tracking, cleanup, dispose, runaway loops are stopped', () => {
  const name = signal('a');
  const log: string[] = [];
  const dispose = effect(() => { log.push('run ' + name.value); return () => log.push('cleanup'); });
  name.value = 'b';
  dispose();
  name.value = 'c';
  assert.deepEqual(log, ['run a', 'cleanup', 'run b', 'cleanup']);
  // An effect that writes a signal it reads runs once, then loops forever on the next change: stopped.
  const n = signal(0);
  effect(() => { n.value = n.value + 1; });
  assert.equal(n.value, 1);
  assert.throws(() => { n.value = 10; }, /IBU203/);
});

test('resource: loading/data/error and latest-request-wins', async () => {
  let resolveFirst!: (v: string) => void;
  let call = 0;
  const r = resource(() => ++call === 1 ? new Promise<string>(res => { resolveFirst = res; }) : Promise.resolve('second'));
  assert.equal(r.loading.value, true);
  await r.refresh();
  resolveFirst('first (stale)');
  await new Promise(res => setTimeout(res, 0));
  assert.equal(r.data.value, 'second');
  assert.equal(r.loading.value, false);
  const failing = resource(() => Promise.reject(new Error('nope')));
  await new Promise(res => setTimeout(res, 0));
  assert.equal((failing.error.value as Error).message, 'nope');
});

test('isSafeUrl follows the browser URL parser', () => {
  for (const ok of ['/notes', 'notes/1', '#top', '?q=1', 'https://example.com', 'mailto:a@b.co', 'tel:+1555', '//cdn.example/x.js', '']) assert.equal(isSafeUrl(ok), true, ok);
  for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:x', ' javascript:x', 'java\tscript:x', 'java\nscript:x', '\x01javascript:x', 'vbscript:x', 'data:text/html,x', 'file:///etc/passwd', 'blob:http://x/1']) assert.equal(isSafeUrl(bad), false, JSON.stringify(bad));
  assert.equal(isSafeUrl('data:image/png;base64,AAAA', 'img', 'src'), true);
  assert.equal(isSafeUrl('blob:http://localhost/123', 'img', 'src'), true);
  assert.equal(isSafeUrl('data:image/svg+xml,<svg onload=alert(1)>', 'img', 'src'), false);
  assert.equal(isSafeUrl('data:image/png;base64,AAAA', 'a', 'href'), false);
});

test('classNames accepts strings, arrays and objects', () => {
  assert.equal(classNames(['btn', false, { active: true, hidden: 0 }, null, 'big']), 'btn active big');
});

test('renderToString escapes text and attributes and applies the same security rules', () => {
  const violations: SecurityViolation[] = [];
  onSecurityViolation(v => violations.push(v));
  const evil = '"><script>alert(1)</script>';
  const name = signal('Ibu');
  const out = renderToString(
    <main class={['page', { dark: true }]} style={{ fontSize: 18, marginTop: 0 }}>
      <h1 title={evil}>{evil}</h1>
      <a href="javascript:alert(1)">bad link</a>
      <img src="data:image/png;base64,AAAA" alt="ok" />
      <input bind={name} disabled />
      <button onClick={() => {}}>click</button>
      {[1, 2].map(n => <i key={n}>{n}</i>)}
    </main>
  ).toString();
  onSecurityViolation(null);
  assert.equal(out, '<main class="page dark" style="font-size:18px;margin-top:0"><h1 title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</h1><a href="about:blank#blocked">bad link</a><img src="data:image/png;base64,AAAA" alt="ok"><input value="Ibu" disabled><button>click</button><i>1</i><i>2</i></main>');
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'IBU101');
  assert.throws(() => renderToString(<script>{'alert(1)'}</script>), /IBU103/);
  assert.throws(() => renderToString(<div innerHTML="<b>x</b>" />), /IBU102/);
  assert.throws(() => renderToString(<style>{'</style><script>alert(1)</script>'}</style>), /IBU108/);
  assert.throws(() => renderToString(<p>{JSON.parse('{"type":"script","props":{}}')}</p>), /IBU106/);
  assert.throws(() => renderToString(<p>{(() => 1) as never}</p>), /IBU105/);
});

test('html`` and SafeHtml: escaping by default, no way to forge trusted HTML', () => {
  assert.equal(html`<b>${'<i>'}</b>${html`<br>`}${['<a>', html`<hr>`]}`.toString(), '<b>&lt;i&gt;</b><br>&lt;a&gt;<hr>');
  assert.throws(() => new SafeHtml(Symbol('fake'), '<script>'), /IBU109/);
});

test('createApp: renders, batches updates, keeps controlled inputs in sync', async () => {
  const root = newRoot();
  const count = signal(0);
  const text = signal('');
  let renders = 0;
  createApp(() => { renders++; return <div><span id="c">{count}</span><input id="t" value={text.value} onInput={e => { text.value = e.target.value; }} /></div>; }, root);
  assert.equal(root.querySelector('#c')!.textContent, '0');
  count.value++; count.value++; count.value++;
  await nextTick();
  assert.equal(root.querySelector('#c')!.textContent, '3');
  assert.equal(renders, 2, 'three writes, one re-render');
  const input = root.querySelector('#t') as HTMLInputElement;
  input.value = 'typed';
  input.dispatchEvent(new window.Event('input') as unknown as Event);
  await nextTick();
  text.value = '';
  await nextTick();
  assert.equal(input.value, '', 'clearing the signal clears what the user sees (v0.5 bug)');
});

test('createApp: bind, refs, events swap without re-binding, SVG namespace', async () => {
  const root = newRoot();
  const agree = signal(false);
  const label = signal('first');
  const ref: { current: Element | null } = { current: null };
  const clicks: string[] = [];
  createApp(() => (
    <div>
      <input id="cb" type="checkbox" bind={agree} />
      <button id="b" ref={ref} onClick={() => clicks.push(label.value)}>go</button>
      <svg id="s" viewBox="0 0 10 10"><circle r="5" /></svg>
    </div>
  ), root);
  const cb = root.querySelector('#cb') as HTMLInputElement;
  cb.checked = true;
  cb.dispatchEvent(new window.Event('change') as unknown as Event);
  assert.equal(agree.value, true);
  assert.equal(ref.current, root.querySelector('#b'));
  (root.querySelector('#b') as HTMLButtonElement).click();
  label.value = 'second';
  await nextTick();
  (root.querySelector('#b') as HTMLButtonElement).click();
  assert.deepEqual(clicks, ['first', 'second']);
  assert.equal(root.querySelector('#s')!.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(root.querySelector('circle')!.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.throws(() => createApp(() => <input bind={'nope' as never} />, newRoot(), { onError: e => { throw e; } }), /IBU205/);
});

test('createApp: keyed lists reuse DOM nodes; render errors keep the last good page', async () => {
  const root = newRoot();
  const items = signal([{ id: 1, t: 'a' }, { id: 2, t: 'b' }, { id: 3, t: 'c' }]);
  const broken = signal(false);
  const errors: unknown[] = [];
  const Item = (props: { t: string }) => <li>{props.t}</li>;
  createApp(() => {
    if (broken.value) throw new Error('component crashed');
    return <ul>{items.value.map(i => <Item key={i.id} t={i.t} />)}</ul>;
  }, root, { onError: e => errors.push(e) });
  const firstLi = root.querySelector('li');
  items.value = [...items.value].reverse();
  await nextTick();
  assert.equal(root.textContent, 'cba');
  assert.equal(root.querySelector('ul')!.lastChild, firstLi);
  broken.value = true;
  await nextTick();
  assert.equal(errors.length, 1);
  assert.equal(root.textContent, 'cba', 'previous DOM still shown');
  broken.value = false;
  await nextTick();
  assert.equal(root.textContent, 'cba', 'recovers when state is fixed');
});

test('createApp: friendly error for a missing mount target, selector support, unmount', () => {
  assert.throws(() => createApp(() => 'x', '#does-not-exist'), /IBU201.*#does-not-exist/s);
  const root = newRoot();
  root.id = 'mount-here';
  root.innerHTML = '<p>server-rendered</p>';
  const app = createApp(() => <b>client</b>, '#mount-here');
  assert.equal(root.innerHTML, '<b>client</b>');
  app.unmount();
  assert.equal(root.innerHTML, '');
});

test('router: params, wildcard, Link, navigation stays on this site', async () => {
  assert.deepEqual(matchRoute('/users/:id', '/users/hello%20world'), { id: 'hello world' });
  assert.equal(matchRoute('/users/:id', '/users'), null);
  assert.equal(matchRoute('/users/:id', '/users/%ZZ'), null);
  assert.deepEqual(matchRoute('/docs/*', '/docs/a/b'), { '*': 'a/b' });
  const router = createRouter([
    { path: '/', component: () => 'Home' },
    { path: '/notes/:id', component: ({ id }) => 'Note ' + id }
  ], () => 'Missing');
  const root = newRoot();
  createApp(() => <div><router.Link href="/notes/7">open</router.Link><p>{router.view()}</p></div>, root);
  assert.equal(root.querySelector('p')!.textContent, 'Home');
  assert.equal(root.querySelector('a')!.getAttribute('href'), '/notes/7');
  (root.querySelector('a') as HTMLAnchorElement).click();
  await nextTick();
  assert.equal(root.querySelector('p')!.textContent, 'Note 7');
  assert.equal(location.pathname, '/notes/7');
  assert.throws(() => router.navigate('https://evil.example/'), /IBU301/);
  assert.throws(() => router.navigate('//evil.example/'), /IBU301/);
  router.navigate('/nowhere?x=1');
  await nextTick();
  assert.equal(root.querySelector('p')!.textContent, 'Missing');
  assert.equal(router.query().get('x'), '1');
  router.dispose();
});

test('api() only talks to its own origin', async () => {
  for (const target of ['https://evil.example/x', '//evil.example/x', '/\\evil.example/x', 'http://localhost:3001/x']) {
    await assert.rejects(api(target), /IBU304/, target);
  }
});
