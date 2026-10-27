import { DEV, IbuError } from './errors.js';
import { classNames, cssName, isEventProp, sanitizeAttribute, type ClassValue } from './security.js';
import { isSignal, track, type Signal, type Subscribable } from './signals.js';
import { resolve, type Child, type Component, type Props, type ResolvedElement, type ResolvedNode } from './vnode.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
// Set as live DOM properties so the screen always matches state (attributes only set defaults).
const LIVE_PROPS = new Set(['value', 'checked', 'selected', 'indeterminate', 'muted']);
const UNITLESS = new Set(['opacity', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'order', 'fontWeight', 'lineHeight', 'zoom', 'gridRow', 'gridColumn', 'columnCount', 'tabSize', 'aspectRatio', 'scale']);

type Entry = { r: ResolvedNode; node: Node; children: Entry[] };

// One shared listener per event type; re-renders swap the handler without touching the DOM.
const handlers = new WeakMap<Element, Map<string, (event: Event) => void>>();
function dispatch(this: Element, event: Event) { handlers.get(this)?.get(event.type)?.call(this, event); }
function setListener(el: Element, key: string, handler: unknown) {
  const name = key.slice(2).toLowerCase();
  const type = name === 'doubleclick' ? 'dblclick' : name;
  let map = handlers.get(el);
  if (!map) handlers.set(el, map = new Map());
  if (typeof handler !== 'function') { if (map.delete(type)) el.removeEventListener(type, dispatch); return; }
  if (!map.has(type)) el.addEventListener(type, dispatch);
  map.set(type, handler as (event: Event) => void);
}

function setLive(el: Element, key: string, val: unknown) {
  const target = el as unknown as Record<string, unknown>;
  const next = key === 'value' ? (val == null ? '' : String(val)) : !!val;
  if (target[key] !== next) target[key] = next;
}

// bind={name} keeps an input and a signal in sync in both directions.
const bindings = new WeakMap<Element, Signal<unknown>>();
function onBoundInput(this: HTMLInputElement) {
  const sig = bindings.get(this);
  if (!sig) return;
  if (this.type === 'checkbox') sig.value = this.checked;
  else if (this.type === 'radio') { if (this.checked) sig.value = this.value; }
  else if (typeof sig.peek() === 'number') { if (this.value.trim() !== '' && !Number.isNaN(Number(this.value))) sig.value = Number(this.value); }
  else sig.value = this.value;
}
function setBinding(el: Element, tag: string, sig: unknown) {
  if (!isSignal(sig) || !('set' in sig)) {
    throw new IbuError('IBU205', `bind on <${tag}> needs a writable signal, got ${typeof sig}.`, "Create one with const name = signal('') and pass the signal itself: bind={name} (not name.value).");
  }
  if (!bindings.has(el)) { el.addEventListener('input', onBoundInput); el.addEventListener('change', onBoundInput); }
  bindings.set(el, sig as Signal<unknown>);
  const input = el as HTMLInputElement;
  const value = sig.value;
  if (input.type === 'checkbox') setLive(el, 'checked', value);
  else if (input.type === 'radio') setLive(el, 'checked', value === input.value);
  else setLive(el, 'value', value);
}

function applyStyle(el: HTMLElement, val: unknown, old: unknown) {
  const style = el.style;
  if (val != null && typeof val !== 'string' && (typeof val !== 'object' || Array.isArray(val))) {
    throw new IbuError('IBU107', `style must be an object or a string, got ${Array.isArray(val) ? 'an array' : typeof val}.`, "style={{ color: 'red', fontSize: 18 }} or style=\"color: red\".");
  }
  if (typeof val === 'string') { style.cssText = val; return; }
  if (typeof old === 'string') style.cssText = '';
  else if (old && typeof old === 'object') {
    for (const name of Object.keys(old)) if (!val || !(name in val)) style.removeProperty(cssName(name));
  }
  if (val) {
    for (const [name, v] of Object.entries(val)) {
      if (v == null || v === false) style.removeProperty(cssName(name));
      else style.setProperty(cssName(name), typeof v === 'number' && v !== 0 && !UNITLESS.has(name) ? v + 'px' : String(v));
    }
  }
}

function setRef(ref: unknown, el: Element | null) {
  if (typeof ref === 'function') ref(el);
  else if (ref && typeof ref === 'object' && 'current' in ref) (ref as { current: unknown }).current = el;
}

function setProp(el: Element, tag: string, key: string, val: unknown, old: unknown) {
  if (key === 'children' || key === 'key' || key === 'bind') return;
  if (key === 'ref') { if (val !== old) setRef(val, el); return; }
  if (isEventProp(key)) { setListener(el, key, val); return; }
  if (key === 'style') { applyStyle(el as HTMLElement, val, old); return; }
  if (key === 'class' || key === 'className') {
    const value = classNames(val as ClassValue);
    if (value) el.setAttribute('class', value); else el.removeAttribute('class');
    return;
  }
  if (LIVE_PROPS.has(key) && key in el) { setLive(el, key, val); return; }
  const attr = key === 'htmlFor' ? 'for' : key;
  if (val == null || val === false) { el.removeAttribute(attr); return; }
  const value = sanitizeAttribute(tag, attr, val === true ? '' : String(val));
  if (attr.startsWith('xlink:')) el.setAttributeNS(XLINK_NS, attr, value);
  else el.setAttribute(attr, value);
}

function applyProps(el: Element, tag: string, next: Props, prev?: Props) {
  if (prev) for (const key of Object.keys(prev)) if (!(key in next)) setProp(el, tag, key, undefined, prev[key]);
  for (const key of Object.keys(next)) {
    if (!prev || LIVE_PROPS.has(key) || !Object.is(prev[key], next[key])) setProp(el, tag, key, next[key], prev?.[key]);
  }
  // Applied last so `type` is already set, and re-read every render so the signal is tracked.
  if ('bind' in next) setBinding(el, tag, next.bind);
  else if (prev && 'bind' in prev) bindings.delete(el);
}

function mount(r: ResolvedNode, svg: boolean): Entry {
  if (typeof r === 'string') return { r, node: document.createTextNode(r), children: [] };
  const inSvg = svg || r.tag === 'svg';
  const el = inSvg ? document.createElementNS(SVG_NS, r.tag) : document.createElement(r.tag);
  const children = r.children.map(c => mount(c, inSvg && r.tag !== 'foreignObject'));
  el.append(...children.map(c => c.node));
  applyProps(el, r.tag, r.props);
  return { r, node: el, children };
}

const keyOf = (r: ResolvedNode) => typeof r === 'string' ? undefined : r.props.key;
const warned = new Set<string>();
function warnOnce(message: string) { if (!warned.has(message)) { warned.add(message); console.warn(message); } }

function reconcile(parent: Node, old: Entry[], next: ResolvedNode[], svg: boolean): Entry[] {
  const keyed = new Map<unknown, Entry>();
  for (const entry of old) { const key = keyOf(entry.r); if (key != null) keyed.set(key, entry); }
  const used = new Set<Entry>();
  const seen = DEV ? new Set<unknown>() : undefined;
  const result = next.map((r, index) => {
    const key = keyOf(r);
    if (seen && key != null) {
      if (seen.has(key)) warnOnce(`[IBU204] Two siblings share the key ${JSON.stringify(key)}; list items may be reused incorrectly. Use a unique id per item.\n  More: npx ibu explain IBU204`);
      seen.add(key);
    }
    let previous = key != null ? keyed.get(key) : old[index];
    if (key == null && previous && keyOf(previous.r) != null) previous = undefined;
    if (previous && used.has(previous)) previous = undefined;
    if (previous) used.add(previous);
    if (!previous || typeof previous.r !== typeof r || (typeof r !== 'string' && (previous.r as ResolvedElement).tag !== r.tag)) return mount(r, svg);
    if (typeof r === 'string') {
      if (previous.r !== r) (previous.node as Text).data = r;
      previous.r = r;
      return previous;
    }
    const el = previous.node as Element;
    const inSvg = svg || r.tag === 'svg';
    previous.children = reconcile(el, previous.children, r.children, inSvg && r.tag !== 'foreignObject');
    applyProps(el, r.tag, r.props, (previous.r as ResolvedElement).props);
    previous.r = r;
    return previous;
  });
  result.forEach((entry, i) => {
    const at = parent.childNodes[i];
    if (at !== entry.node) parent.insertBefore(entry.node, at ?? null);
  });
  const retained = new Set(result.map(x => x.node));
  for (const entry of old) if (!retained.has(entry.node) && entry.node.parentNode === parent) parent.removeChild(entry.node);
  return result;
}

const OVERLAY_ID = 'ibu-error-overlay';
function showOverlay(error: unknown) {
  let el = document.getElementById(OVERLAY_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.setAttribute('role', 'alert');
    Object.assign(el.style, { position: 'fixed', left: '16px', right: '16px', bottom: '16px', maxHeight: '50vh', overflow: 'auto', zIndex: '2147483647', background: '#2b0d12', color: '#ffe4e6', border: '1px solid #fb7185', borderRadius: '12px', padding: '16px', font: '13px/1.5 ui-monospace, monospace', whiteSpace: 'pre-wrap' });
    document.body.append(el);
  }
  el.textContent = `IbuJS could not render the page, so the last working version is still shown.\n\n${error instanceof Error ? error.message : String(error)}\n\n(This box only appears during development.)`;
}
function reportRenderError(error: unknown) {
  console.error(error);
  if (DEV && typeof document !== 'undefined') showOverlay(error);
}

let renders = 0, resetQueued = false;
function countRender() {
  if (!resetQueued) { resetQueued = true; setTimeout(() => { renders = 0; resetQueued = false; }, 0); }
  if (++renders > 1000) {
    throw new IbuError('IBU203', 'The app re-rendered more than 1000 times without pausing.', 'A component probably writes to a signal it reads while rendering. Move the write into an event handler or effect().');
  }
}

export interface App { update(): void; unmount(): void; root: Element }
export interface AppOptions { onError?: (error: unknown) => void }

// Renders view into target and re-renders (batched, once per microtask) when any signal it read changes.
// target can be an element or a CSS selector. Any existing content (e.g. server-rendered HTML) is replaced.
export function createApp(view: (() => Child) | Component, target: Element | string | null, options: AppOptions | Subscribable[] = {}): App {
  const root = typeof target === 'string' ? document.querySelector(target) : target;
  if (!root) {
    throw new IbuError('IBU201', `The mount target ${typeof target === 'string' ? `"${target}" ` : ''}was not found.`, 'Add <div id="app"></div> to index.html and load your script with type="module" (which runs after the page is parsed).');
  }
  const extraDeps = Array.isArray(options) ? options : [];
  const onError = (!Array.isArray(options) && options.onError) || reportRenderError;
  const svg = root.namespaceURI === SVG_NS;
  let entries: Entry[] = [];
  let deps = new Set<Subscribable>();
  let unsubs: Array<() => void> = [];
  let disposed = false, scheduled = false;
  const schedule = () => { if (!scheduled && !disposed) { scheduled = true; queueMicrotask(update); } };
  const subscribe = (next: Set<Subscribable>) => {
    unsubs.forEach(u => u());
    deps = next;
    unsubs = [...next].map(d => d.subscribe(schedule));
  };
  function update() {
    scheduled = false;
    if (disposed) return;
    const observed = new Set<Subscribable>(extraDeps);
    try {
      countRender();
      track(() => {
        // Resolving first means a broken component throws before the DOM is touched.
        const tree = resolve((view as Component)({}));
        try { entries = reconcile(root!, entries, tree, svg); }
        catch (err) { root!.replaceChildren(); entries = []; throw err; }
      }, observed);
      subscribe(observed);
      if (DEV) document.getElementById(OVERLAY_ID)?.remove();
    } catch (error) {
      // Keep listening, so fixing the state that caused the error re-renders the app.
      subscribe(new Set([...deps, ...observed]));
      onError(error);
    }
  }
  root.replaceChildren();
  update();
  return {
    update,
    unmount() { disposed = true; unsubs.forEach(u => u()); root.replaceChildren(); entries = []; },
    root
  };
}

// Resolves after pending re-renders have been applied to the DOM.
export const nextTick = () => new Promise<void>(r => setTimeout(r, 0));
