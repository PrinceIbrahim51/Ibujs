// Source of demo/index.html: a standalone, offline showcase built from the real @ibujs/ui engine.
// Rebuild with `npm run demo`.
import { createApp, createRouter, signal, computed, effect, renderToString, isSafeUrl, onSecurityViolation, h, type SecurityViolation } from '@ibujs/ui';

// ---- Counter ----
const count = signal(0);
const doubled = computed(() => count.value * 2);
function Counter() {
  return (
    <section class="panel">
      <h2>Reactive counter</h2>
      <p class="count">{count}</p>
      <p class="muted">Doubled (computed): {doubled}</p>
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
      <p class="muted">Kept in this browser (localStorage). In a real app they go to SQLite through the server. Try a note like &lt;img src=x onerror=alert(1)&gt;.</p>
      <form class="row" onSubmit={addNote}>
        <input bind={draft} placeholder="Write a note" aria-label="New note" maxlength="300" />
        <button disabled={!draft.value.trim()}>Add note</button>
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
interface Attack { name: string; v05: string; build: () => unknown }
const attacks: Attack[] = [
  { name: 'javascript: link', v05: 'Blocked', build: () => h('a', { href: 'javascript:alert(document.cookie)' }, 'Click me') },
  { name: 'javascript: hidden by a tab', v05: 'Executed', build: () => h('a', { href: 'java\tscript:alert(1)' }, 'Click me') },
  { name: 'javascript: hidden by a newline', v05: 'Executed', build: () => h('a', { href: 'java\nscript:alert(1)' }, 'Click me') },
  { name: 'Control character before javascript:', v05: 'Executed', build: () => h('a', { href: '\x01javascript:alert(1)' }, 'Click me') },
  { name: 'iframe srcdoc', v05: 'Executed', build: () => h('iframe', { srcdoc: '<script>alert(1)</script>' }) },
  { name: 'API data shaped like an element', v05: 'Executed', build: () => h('p', {}, 'By: ', JSON.parse('{"type":"script","props":{"children":["alert(1)"]}}')) },
  // v0.5 could not render SVG at all, so this only matters now that SVG works.
  { name: 'SVG <animate> rewriting href', v05: 'SVG broken', build: () => h('svg', {}, h('a', {}, h('animate', { attributeName: 'href', values: 'javascript:alert(1)' }), h('text', {}, 'x'))) },
  { name: '<script> element', v05: 'Executed', build: () => h('script', {}, 'alert(1)') },
  { name: 'onclick="..." string', v05: 'Blocked', build: () => h('button', { onclick: 'alert(1)' }, 'x') },
  { name: 'innerHTML prop', v05: 'Blocked', build: () => h('div', { innerHTML: '<img src=x onerror=alert(1)>' }) },
  { name: 'Text that looks like HTML', v05: 'Escaped', build: () => h('p', {}, '<img src=x onerror=alert(1)>') }
];
function runAttack(attack: Attack) {
  const violations: SecurityViolation[] = [];
  onSecurityViolation(v => violations.push(v));
  try {
    const out = renderToString(attack.build() as never).toString();
    return violations.length
      ? { verdict: 'Neutralised', detail: `${violations[0].code}: unsafe value replaced → ${out}` }
      : { verdict: 'Safe', detail: `Rendered as harmless text → ${out}` };
  } catch (err) {
    return { verdict: 'Refused', detail: String((err as Error).message).split('\n')[0] };
  } finally {
    onSecurityViolation(null);
  }
}
const results = attacks.map(attack => ({ ...attack, ...runAttack(attack) }));
const customUrl = signal('java\tscript:alert(1)');
const urlVerdict = computed(() => isSafeUrl(customUrl.value) ? 'Allowed' : 'Blocked (IBU101)');
function Playground() {
  return (
    <section class="panel">
      <h2>Security playground</h2>
      <p class="muted">Real exploits from the v0.5 audit, run through this page's actual IbuJS engine.</p>
      <div class="table" role="table" aria-label="Attack results">
        <div class="tr th" role="row"><span role="columnheader">Attack</span><span role="columnheader">v0.5</span><span role="columnheader">v0.6</span></div>
        {results.map(r => (
          <div class="tr" role="row" key={r.name}>
            <span role="cell">{r.name}<small>{r.detail}</small></span>
            <span role="cell" class={r.v05 === 'Executed' ? 'bad' : r.v05 === 'SVG broken' ? 'muted' : 'ok'}>{r.v05}</span>
            <span role="cell" class="ok">{r.verdict}</span>
          </div>
        ))}
      </div>
      <h3>Try your own URL</h3>
      <div class="row">
        <input bind={customUrl} aria-label="URL to test" />
        <span class={urlVerdict.value === 'Allowed' ? 'ok' : 'bad'}>{urlVerdict}</span>
      </div>
      <p class="muted">Rendered link: <a href={customUrl.value} target="_blank" rel="noopener">{customUrl.value || '(empty)'}</a></p>
    </section>
  );
}

// ---- AI ----
function AI() {
  return (
    <section class="panel">
      <h2>AI built in</h2>
      <p>This offline page cannot call Claude, so here is what the AI features do in a real project:</p>
      <pre>{`$ npx ibu ai "add a page that lists my notes with a delete button"
Asking Claude (claude-opus-5-5) with 4 project files…

Adds a /notes page and DELETE /api/notes/:id route.

  + new      src/pages/Notes.tsx   +41 -0 lines
  ~ modified src/server.ts         +7 -0 lines
  ~ modified src/main.tsx          +3 -1 lines

Apply 3 file changes? [y/N]`}</pre>
      <ul>
        <li><b>ibu ai</b>: describe a change in plain English; every proposed file is path-checked and security-linted before you approve it.</li>
        <li><b>ibu review</b>: an AI security review of your code.</li>
        <li><b>ibu explain IBU412</b>: every error has a code with a plain-English fix (offline), or <b>--ai</b> for a tailored answer.</li>
        <li><b>@ibujs/ai</b>: <code>app.post('/api/ask', ai.route())</code> streams answers with your key kept on the server, plus rate and cost limits.</li>
        <li><b>AGENTS.md + llms.txt</b>: Cursor, Claude Code and Copilot write correct, secure IbuJS code from the first prompt.</li>
      </ul>
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
      <span class="pill">IBUJS v0.6 • LIVE DEMO</span>
      <h1>Build your own web.</h1>
      <p>Full-stack TypeScript + JSX, secure by default, made for beginners and AI. This page runs the real IbuJS engine.</p>
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
