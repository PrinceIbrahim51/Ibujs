import { IbuError } from './errors.js';

export type Listener = () => void;
export interface Subscribable { subscribe(fn: Listener): () => void }
export const SIGNAL: unique symbol = Symbol.for('ibujs.signal');
export interface ReadonlySignal<T> extends Subscribable { readonly [SIGNAL]: true; readonly value: T; peek(): T }
export interface Signal<T> extends ReadonlySignal<T> {
  value: T;
  set(next: T): void;
  update(fn: (current: T) => T): void;
}

let observer: Set<Subscribable> | null = null;
let batchDepth = 0;
const queued = new Set<Listener>();
// Listeners that only mark state stale run immediately, even inside batch(), so reads stay fresh.
const immediate = new WeakSet<Listener>();

export function isSignal(value: unknown): value is ReadonlySignal<unknown> {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[SIGNAL] === true;
}

function notify(listeners: Set<Listener>) {
  for (const fn of [...listeners]) {
    if (batchDepth > 0 && !immediate.has(fn)) queued.add(fn);
    else fn();
  }
}

// Runs fn and collects every signal it reads into `deps` (which is filled even if fn throws).
export function track(fn: () => void, deps: Set<Subscribable> = new Set()): Set<Subscribable> {
  const previous = observer;
  observer = deps;
  try { fn(); } finally { observer = previous; }
  return deps;
}

export function untrack<T>(fn: () => T): T {
  const previous = observer;
  observer = null;
  try { return fn(); } finally { observer = previous; }
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const listeners = new Set<Listener>();
  const s: Signal<T> = {
    [SIGNAL]: true,
    get value() { observer?.add(s); return value; },
    set value(next: T) { if (!Object.is(next, value)) { value = next; notify(listeners); } },
    peek: () => value,
    set(next) { s.value = next; },
    update(fn) { s.value = fn(value); },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }
  };
  return s;
}

// A read-only signal derived from other signals; recomputed lazily when one of them changes.
export function computed<T>(fn: () => T): ReadonlySignal<T> {
  let value!: T;
  let dirty = true;
  let unsubs: Array<() => void> = [];
  const listeners = new Set<Listener>();
  const invalidate = () => { if (!dirty) { dirty = true; notify(listeners); } };
  immediate.add(invalidate);
  const refresh = () => {
    const deps = track(() => { value = fn(); });
    unsubs.forEach(u => u());
    unsubs = [...deps].map(d => d.subscribe(invalidate));
    dirty = false;
  };
  const c: ReadonlySignal<T> = {
    [SIGNAL]: true,
    get value() { observer?.add(c); if (dirty) refresh(); return value; },
    peek() { if (dirty) refresh(); return value; },
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; }
  };
  return c;
}

// Groups several signal writes so listeners run once at the end.
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try { return fn(); } finally {
    if (--batchDepth === 0) {
      const pending = [...queued];
      queued.clear();
      for (const listener of pending) listener();
    }
  }
}

const cleanups = new Set<() => void>();
export function onCleanup(fn: () => void) { cleanups.add(fn); return () => cleanups.delete(fn); }
export function disposeEffects() { for (const fn of [...cleanups]) { cleanups.delete(fn); fn(); } }

// Runs fn now and again whenever a signal it reads changes. fn may return a cleanup function.
// `dependencies` (the v0.5 form) adds signals to watch even if fn does not read them.
export function effect(fn: () => void | (() => void), dependencies: Subscribable[] = []): () => void {
  let cleanup: void | (() => void);
  let unsubs: Array<() => void> = [];
  let disposed = false, running = false, rerun = false;
  const run = () => {
    if (disposed) return;
    if (running) { rerun = true; return; }
    running = true;
    try {
      let rounds = 0;
      do {
        rerun = false;
        if (++rounds > 100) throw new IbuError('IBU203', 'An effect keeps changing a signal it also reads, so it re-ran 100 times in a row.', 'Read with signal.peek() to avoid subscribing, or move the write out of the effect.');
        if (typeof cleanup === 'function') cleanup();
        const deps = track(() => { cleanup = fn(); }, new Set(dependencies));
        unsubs.forEach(u => u());
        unsubs = [...deps].map(d => d.subscribe(run));
      } while (rerun);
    } finally { running = false; }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    unsubs.forEach(u => u());
    if (typeof cleanup === 'function') cleanup();
    cleanups.delete(dispose);
  };
  cleanups.add(dispose);
  run();
  return dispose;
}

export interface Resource<T> {
  data: Signal<T | undefined>;
  error: Signal<unknown>;
  loading: Signal<boolean>;
  refresh(): Promise<void>;
  mutate(value: T | undefined): void;
}

// Loads async data into signals: `const notes = resource(() => api.get('/api/notes'))`.
// Out-of-order responses are ignored, so the latest refresh always wins.
export function resource<T>(fetcher: () => Promise<T>, options: { initial?: T; lazy?: boolean } = {}): Resource<T> {
  const data = signal<T | undefined>(options.initial);
  const error = signal<unknown>(null);
  const loading = signal(false);
  let request = 0;
  const refresh = async () => {
    const id = ++request;
    batch(() => { loading.value = true; error.value = null; });
    try {
      const result = await fetcher();
      if (id === request) data.value = result;
    } catch (err) {
      if (id === request) error.value = err;
    } finally {
      if (id === request) loading.value = false;
    }
  };
  if (!options.lazy) void refresh();
  return { data, error, loading, refresh, mutate: value => { data.value = value; } };
}
