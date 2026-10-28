import { createApp, createRouter, signal, computed, effect, resource, api, ApiError } from '@ibumomujs/ui';
import './style.css';

type Note = { id: number; text: string; created_at: string };

// Counter: signals hold state; anything that reads them updates automatically.
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

// Notes: stored in SQLite on the server, loaded with resource(), sent with api.post().
const notes = resource(() => api.get<Note[]>('/api/notes'), { lazy: true });
const draft = signal('');
const notesError = signal('');

async function addNote(event: SubmitEvent) {
  event.preventDefault();
  notesError.value = '';
  try {
    const note = await api.post<Note>('/api/notes', { text: draft.value });
    notes.mutate([note, ...(notes.data.value ?? [])]);
    draft.value = '';
  } catch (err) {
    notesError.value = err instanceof ApiError ? err.message : 'Could not save the note.';
  }
}

async function removeNote(id: number) {
  await api.delete(`/api/notes/${id}`);
  notes.mutate((notes.data.value ?? []).filter(note => note.id !== id));
}

function Notes() {
  return (
    <section class="panel">
      <h2>Notes</h2>
      <p class="muted">Write a note and press Add: it is saved in the database.</p>
      <form class="row" onSubmit={addNote}>
        <input bind={draft} placeholder="Write a note" maxlength="500" aria-label="New note" />
        <button disabled={!draft.value.trim()}>Add</button>
      </form>
      {notesError.value && <p class="error" role="alert">{notesError}</p>}
      {notes.loading.value && <p class="muted">Loading…</p>}
      <ul class="notes">
        {(notes.data.value ?? []).map(note => (
          <li key={note.id}>
            <span>{note.text}</span>
            <button class="link" aria-label="Delete note" onClick={() => removeNote(note.id)}>✕</button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Ask AI: the answer streams in word by word. It is rendered as text, so even a
// manipulated AI answer cannot inject HTML or scripts into the page.
const question = signal('');
const answer = signal('');
const asking = signal(false);

async function ask(event: SubmitEvent) {
  event.preventDefault();
  if (!question.value.trim() || asking.value) return;
  answer.value = '';
  asking.value = true;
  try {
    for await (const chunk of api.stream('/api/ask', { prompt: question.value })) answer.value += chunk;
  } catch (err) {
    answer.value = err instanceof ApiError ? err.message : 'Something went wrong. Please try again.';
  } finally {
    asking.value = false;
  }
}

function Ask() {
  return (
    <section class="panel">
      <h2>Ask AI</h2>
      <p class="muted">Type a question and press Ask.</p>
      <form class="row" onSubmit={ask}>
        <input bind={question} placeholder="Ask anything" maxlength="2000" aria-label="Question" />
        <button disabled={asking.value}>{asking.value ? 'Thinking…' : 'Ask'}</button>
      </form>
      <p class="answer" aria-live="polite">{answer}</p>
    </section>
  );
}

const router = createRouter([
  { path: '/', component: Counter },
  { path: '/notes', component: Notes },
  { path: '/ask', component: Ask }
], () => <section class="panel"><h2>Page not found</h2></section>);
const { Link } = router;

// Load notes the first time the Notes page is opened.
effect(() => {
  if (router.path.value === '/notes' && notes.data.peek() === undefined) void notes.refresh();
});

function App() {
  return (
    <main class="shell">
      <span class="pill">IBUJS</span>
      <h1>Build your own web.</h1>
      <p>Try each tab, then edit src/main.tsx to make it your own.</p>
      <nav>
        <Link href="/">Counter</Link>
        <Link href="/notes">Notes</Link>
        <Link href="/ask">Ask AI</Link>
      </nav>
      {router.view()}
    </main>
  );
}

createApp(App, '#app');
