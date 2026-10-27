// Rendering engine v2: per-component updates, memoization, error isolation and hydration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createApp, hydrate, signal, nextTick, renderToString, type Child } from '../packages/ui/src/index.js';

const window = new Window({ url: 'http://localhost:3000/' });
Object.assign(globalThis as Record<string, unknown>, { window, document: window.document, location: window.location, history: window.history });
const newRoot = () => { const el = document.createElement('div'); document.body.append(el); return el; };

test('a signal change re-renders only the components that read it', async () => {
  const a = signal(0), b = signal(0);
  const renders = { app: 0, a: 0, b: 0 };
  const A = () => { renders.a++; return <p id="a">{a.value}</p>; };
  const B = () => { renders.b++; return <p id="b">{b.value}</p>; };
  const root = newRoot();
  createApp(() => { renders.app++; return <div><A /><B /></div>; }, root);
  assert.deepEqual(renders, { app: 1, a: 1, b: 1 });
  a.value = 5;
  await nextTick();
  assert.equal(root.querySelector('#a')!.textContent, '5');
  assert.deepEqual(renders, { app: 1, a: 2, b: 1 }, 'App and B did not re-render');
});

test('components with unchanged props are skipped when their parent re-renders', async () => {
  const title = signal('x');
  const label = signal('first');
  let childRenders = 0;
  const Child = (props: { label: string }) => { childRenders++; return <span>{props.label}</span>; };
  const root = newRoot();
  createApp(() => <div><h1>{title}</h1><Child label={label.value} /></div>, root);
  title.value = 'y';
  await nextTick();
  assert.equal(childRenders, 1, 'same props: skipped');
  label.value = 'second';
  await nextTick();
  assert.equal(childRenders, 2, 'new props: re-rendered');
  assert.equal(root.textContent, 'ysecond');
});

test('a crashing component keeps its last output while the rest of the page keeps working', async () => {
  const broken = signal(false);
  const other = signal('ok');
  const errors: unknown[] = [];
  const Fragile = () => { if (broken.value) throw new Error('boom'); return <b>fragile</b>; };
  const Other = () => <i>{other.value}</i>;
  const root = newRoot();
  createApp(() => <div><Fragile /><Other /></div>, root, { onError: e => errors.push(e) });
  broken.value = true;
  await nextTick();
  other.value = 'still updating';
  await nextTick();
  assert.equal(errors.length, 1);
  assert.equal(root.textContent, 'fragilestill updating');
  broken.value = false;
  await nextTick();
  assert.equal(root.textContent, 'fragilestill updating');
});

test('unmounted components stop listening to signals', async () => {
  const show = signal(true);
  const value = signal(0);
  let renders = 0;
  const Watcher = () => { renders++; return <span>{value.value}</span>; };
  const root = newRoot();
  createApp(() => <div>{show.value && <Watcher />}</div>, root);
  show.value = false;
  await nextTick();
  value.value = 1;
  await nextTick();
  assert.equal(renders, 1);
  assert.equal(root.textContent, '');
});

test('keyed components returning several nodes keep correct DOM order', async () => {
  const rows = signal([1, 2, 3]);
  const Row = (props: { n: number }) => <><dt>{props.n}</dt><dd>{props.n * 10}</dd></>;
  const root = newRoot();
  createApp(() => <dl>{rows.value.map(n => <Row key={n} n={n} />)}</dl>, root);
  const firstDt = root.querySelector('dt');
  rows.value = [3, 1, 2];
  await nextTick();
  assert.equal(root.textContent, '330110220');
  assert.equal(root.querySelectorAll('dt')[1], firstDt, 'row 1 moved, not recreated');
});

test('a component that self-updates lands between its siblings', async () => {
  const open = signal(false);
  const Middle = () => open.value ? <p id="m">middle</p> : null;
  const root = newRoot();
  createApp(() => <div><p>first</p><Middle /><p>last</p></div>, root);
  open.value = true;
  await nextTick();
  assert.deepEqual([...root.querySelectorAll('p')].map(p => p.textContent), ['first', 'middle', 'last']);
});

test('hydrate adopts server-rendered HTML instead of rebuilding it', async () => {
  const count = signal(2);
  const name = signal('Ibu');
  const Counter = () => <button id="inc" onClick={() => count.value++}>Clicked {count} times</button>;
  const App = (): Child => <main><h1 class="title">Hello, {name}!</h1><Counter /><input id="n" bind={name} /><svg viewBox="0 0 1 1"><circle r="1" /></svg></main>;
  const root = newRoot();
  root.innerHTML = renderToString(<App />).toString();
  const serverButton = root.querySelector('#inc');
  const serverH1 = root.querySelector('h1');
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => warnings.push(m);
  try { hydrate(App, root); } finally { console.warn = warn; }
  assert.deepEqual(warnings, []);
  assert.equal(root.querySelector('#inc'), serverButton, 'same DOM node kept');
  assert.equal(root.querySelector('h1'), serverH1);
  (root.querySelector('#inc') as HTMLButtonElement).click();
  await nextTick();
  assert.equal(root.querySelector('#inc')!.textContent, 'Clicked 3 times');
  name.value = 'World';
  await nextTick();
  assert.equal(root.querySelector('h1')!.textContent, 'Hello, World!');
  assert.equal((root.querySelector('#n') as HTMLInputElement).value, 'World');
});

test('hydrate falls back to a fresh render when the HTML does not match', () => {
  const root = newRoot();
  root.innerHTML = '<p>stale markup from an older deploy</p>';
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => warnings.push(m);
  try { hydrate(() => <section><h2>fresh</h2></section>, root); } finally { console.warn = warn; }
  assert.equal(root.innerHTML, '<section><h2>fresh</h2></section>');
  assert.match(warnings[0], /IBU206/);
});
