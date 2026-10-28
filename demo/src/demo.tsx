// Source of demo/index.html: a standalone, offline showcase built from the real @ibumomujs/ui engine.
// Rebuild with `npm run demo`.
import { createApp, createRouter, signal, computed, effect, renderToString, isSafeUrl, onSecurityViolation, h, type SecurityViolation } from '@ibumomujs/ui';

// ---- Counter ----
const count = signal(0);
const doubled = computed(() => count.value * 2);
function Counter() {
  return (
    <section class="panel">
      <h2>Counter</h2>
      <p class="muted">Click Increase and watch both numbers update.</p>
      <p class="count">{count}</p>
      <p class="muted">Doubled: {doubled}</p>
      <button onClick={() => count.value++}>Increase +1</button>
      <button class="secondary" onClick={() => (count.value = 0)}>Reset</button>
    </section>
  );
}

// ---- Notes (saved in this browser) ----
type Note = { id: number; text: string };
const load = (): Note[] => { try { return JSON.parse(localStorage.getItem('ibujs-demo-notes') ?? '[]'); } catch { return []; } };
const notes = signal<Note[]>(load());
effect(() => { try { localStorage.setItem('ibujs-demo-notes', JSON.stringify(notes.value)); } catch { /* storage unavailable */ } });
const draft = signal('');
function addNote(event: SubmitEvent) {
  event.preventDefault();
  const text = draft.value.trim();
  if (!text) return;
  notes.update(list => [{ id: Date.now(), text }, ...list]);
  draft.value = '';
}
function Notes() {
  return (
    <section class="panel">
      <h2>Notes</h2>
      <p class="muted">Add a note, even &lt;img src=x onerror=alert(1)&gt;: it shows as plain text.</p>
      <form class="row" onSubmit={addNote}>
        <input bind={draft} placeholder="Write a note" aria-label="New note" maxlength="300" />
        <button disabled={!draft.value.trim()}>Add</button>
      </form>
      <ul class="notes">
        {notes.value.map(note => (
          <li key={note.id}>
            <span>{note.text}</span>
            <button class="link" aria-label="Delete note" onClick={() => notes.update(list => list.filter(n => n.id !== note.id))}>✕</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- Security playground ----
interface Attack { name: string; build: () => unknown }
const attacks: Attack[] = [
  { name: 'javascript: link', build: () => h('a', { href: 'javascript:alert(document.cookie)' }, 'Click me') },
  { name: 'javascript: hidden by a tab', build: () => h('a', { href: 'java\tscript:alert(1)' }, 'Click me') },
  { name: 'javascript: hidden by a newline', build: () => h('a', { href: 'java\nscript:alert(1)' }, 'Click me') },
  { name: 'Control character before javascript:', build: () => h('a', { href: '\x01javascript:alert(1)' }, 'Click me') },
  { name: 'iframe srcdoc', build: () => h('iframe', { srcdoc: '<script>alert(1)</script>' }) },
  { name: 'API data shaped like an element', build: () => h('p', {}, 'By: ', JSON.parse('{"type":"script","props":{"children":["alert(1)"]}}')) },
  { name: 'SVG <animate> rewriting href', build: () => h('svg', {}, h('a', {}, h('animate', { attributeName: 'href', values: 'javascript:alert(1)' }), h('text', {}, 'x'))) },
  { name: '<script> element', build: () => h('script', {}, 'alert(1)') },
  { name: 'onclick="..." string', build: () => h('button', { onclick: 'alert(1)' }, 'x') },
  { name: 'innerHTML prop', build: () => h('div', { innerHTML: '<img src=x onerror=alert(1)>' }) },
  { name: 'Text that looks like HTML', build: () => h('p', {}, '<img src=x onerror=alert(1)>') }
];
function runAttack(attack: Attack) {
  const violations: SecurityViolation[] = [];
  onSecurityViolation(v => violations.push(v));
  try {
    const out = renderToString(attack.build() as never).toString();
    return violations.length
      ? 'Blocked'
      : out.includes('&lt;') ? 'Escaped' : 'Safe';
  } catch {
    return 'Refused';
  } finally {
    onSecurityViolation(null);
  }
}
const results = attacks.map(attack => ({ name: attack.name, verdict: runAttack(attack) }));
const customUrl = signal('java\tscript:alert(1)');
const urlVerdict = computed(() => isSafeUrl(customUrl.value) ? 'Allowed' : 'Blocked');
function Playground() {
  return (
    <section class="panel">
      <h2>Security playground</h2>
      <p class="muted">Paste any link: dangerous ones are blocked before they reach the page.</p>
      <div class="row">
        <input bind={customUrl} aria-label="URL to test" />
        <span class={urlVerdict.value === 'Allowed' ? 'ok' : 'bad'}>{urlVerdict}</span>
      </div>
      <div class="table" role="table" aria-label="Attacks run on this page">
        <div class="tr th" role="row"><span role="columnheader">Attack run on this page</span><span role="columnheader">Result</span></div>
        {results.map(r => (
          <div class="tr" role="row" key={r.name}>
            <span role="cell">{r.name}</span>
            <span role="cell" class="ok">{r.verdict}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---- AI ----
function AI() {
  return (
    <section class="panel">
      <h2>AI built in</h2>
      <p class="muted">In your project, run this and Claude writes, checks and fixes the code:</p>
      <pre>npx ibu ai "add a contact page"</pre>
    </section>
  );
}

// Hash routing works from file:// and any static host.
const router = createRouter([
  { path: '/', component: Counter },
  { path: '/notes', component: Notes },
  { path: '/security', component: Playground },
  { path: '/ai', component: AI }
], () => <section class="panel"><h2>Page not found</h2></section>, { mode: 'hash' });
const { Link } = router;

function App() {
  return (
    <main class="shell">
      <span class="pill">IBUJS v0.7 • LIVE DEMO</span>
      <h1>Build your own web.</h1>
      <p>Pick a tab and try it: this page runs the real IbuJS engine.</p>
      <nav>
        <Link href="/">Counter</Link>
        <Link href="/notes">Notes</Link>
        <Link href="/security">Security</Link>
        <Link href="/ai">AI</Link>
      </nav>
      {router.view()}
    </main>
  );
}

createApp(App, '#app');
