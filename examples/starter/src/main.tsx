import { createApp, signal, createRouter } from '@ibujs/ui';
import './style.css';
const count = signal(0);
const router = createRouter([
  { path: '/', component: () => <section className="panel"><h2>Reactive counter</h2><div className="count">{count.value}</div><button onClick={() => count.value++}>Increase +1</button><button onClick={() => count.value = 0}>Reset</button></section> },
  { path: '/about', component: () => <section className="panel"><h2>About IbuJS</h2><p>TypeScript + JSX with built-in routing and signals.</p></section> },
  { path: '/hello/:name', component: ({name}) => <section className="panel"><h2>Hello, {name}!</h2></section> }
]);
const message = signal('Waiting for request...');
function App() {
  return <main className="shell"><span className="pill">IBUJS v0.2</span><h1>Build your own web.</h1><p>Full-stack TypeScript + JSX without React or Express.</p>
    <nav><button onClick={() => router.navigate('/')}>Counter</button><button onClick={() => router.navigate('/about')}>About</button><button onClick={() => router.navigate('/hello/Commander')}>Dynamic route</button></nav>
    {router.view()}
    <section className="panel"><h2>Backend API</h2><button onClick={async () => { try { const res = await fetch('/api/hello'); if (!res.ok) throw new Error(); const data: {message: string} = await res.json(); message.value = data.message; } catch { message.value = 'Request failed'; } }}>Call /api/hello</button><p aria-live="polite">{message.value}</p></section>
  </main>;
}
const root = document.querySelector('#app');
if (!root) throw new Error('Missing #app');
createApp(() => <App />, root);
