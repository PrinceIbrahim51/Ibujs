import { DEV, IbuError } from './errors.js';
import { classNames, cssName, isEventProp, sanitizeAttribute, type ClassValue } from './security.js';
import { isSignal, track, type Signal, type Subscribable } from './signals.js';
import { flatten, type Child, type Component, type Props, type Shallow, type ShallowComponent, type ShallowElement } from './vnode.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
// Set as live DOM properties so the screen always matches state (attributes only set defaults).
const LIVE_PROPS = new Set(['value', 'checked', 'selected', 'indeterminate', 'muted']);
const UNITLESS = new Set(['opacity', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'order', 'fontWeight', 'lineHeight', 'zoom', 'gridRow', 'gridColumn', 'columnCount', 'tabSize', 'aspectRatio', 'scale']);

// The live tree. Components are real instances with their own signal subscriptions, so a change
// re-renders only the components that read the changed signal.
interface AppState { onError: (error: unknown) => void; failed: Set<CompEntry> }
interface Base { parent: Container; app: AppState; depth: number }
interface TextEntry extends Base { kind: 'text'; value: string; node: Text }
interface ElEntry extends Base { kind: 'el'; tag: string; key: unknown; props: Props; node: Element; children: Entry[]; svg: boolean }
interface CompEntry extends Base {
  kind: 'comp'; fn: Component; key: unknown; props: Props; children: Entry[]; svg: boolean;
  el: Node; deps: Set<Subscribable>; extraDeps: Subscribable[]; unsubs: Array<() => void>;
  listener: () => void; dirty: boolean; disposed: boolean;
}
interface RootEntry { kind: 'root'; node: Element; children: Entry[]; svg: boolean; app: AppState; depth: number }
type Entry = TextEntry | ElEntry | CompEntry;
type Container = ElEntry | CompEntry | RootEntry;

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

const warned = new Set<string>();
function warnOnce(message: string) { if (!warned.has(message)) { warned.add(message); console.warn(message); } }

// ---- Hydration: adopting server-rendered DOM instead of recreating it ----

class HydrationMismatch extends Error {}
interface Hydrator { parent: Node; next: Node | null }
const isBlank = (node: Node) => node.nodeType === 8 || (node.nodeType === 3 && !(node as Text).data.trim());
function describeNode(node: Node | null) {
  if (!node) return 'nothing';
  if (node.nodeType === 3) return `text ${JSON.stringify((node as Text).data.slice(0, 40))}`;
  return node.nodeType === 1 ? `<${(node as Element).localName}>` : node.nodeName;
}
function claimText(hy: Hydrator, value: string): Text {
  let node = hy.next;
  while (node && node.nodeType === 8) node = node.nextSibling;
  if (!node || node.nodeType !== 3) throw new HydrationMismatch(`expected text ${JSON.stringify(value)}, found ${describeNode(node)}`);
  const text = node as Text;
  if (text.data === value) { hy.next = text.nextSibling; return text; }
  // The server writes adjacent strings as one text node; split it to match.
  if (text.data.startsWith(value)) { hy.next = text.splitText(value.length); return text; }
  throw new HydrationMismatch(`expected text ${JSON.stringify(value)}, found ${describeNode(text)}`);
}
function claimElement(hy: Hydrator, tag: string, svg: boolean): Element {
  let node = hy.next;
  while (node && isBlank(node)) node = node.nextSibling;
  const el = node as Element | null;
  if (!el || el.nodeType !== 1 || el.localName !== (svg ? tag : tag.toLowerCase()) || (el.namespaceURI === SVG_NS) !== svg) {
    throw new HydrationMismatch(`expected <${tag}>, found ${describeNode(node)}`);
  }
  hy.next = el.nextSibling;
  return el;
}
function finishHydration(hy: Hydrator, tag: string) {
  // A <textarea>'s text is its default value, not children.
  if (tag === 'textarea') return;
  let node = hy.next;
  while (node) {
    const next = node.nextSibling;
    if (!isBlank(node)) throw new HydrationMismatch(`unexpected ${describeNode(node)} at the end of <${tag}>`);
    hy.parent.removeChild(node);
    node = next;
  }
}

// ---- The component tree ----

function domNodes(entry: Entry, out: Node[] = []): Node[] {
  if (entry.kind === 'comp') for (const child of entry.children) domNodes(child, out);
  else out.push(entry.node);
  return out;
}
function firstNode(entry: Entry): Node | null {
  if (entry.kind !== 'comp') return entry.node;
  for (const child of entry.children) { const node = firstNode(child); if (node) return node; }
  return null;
}
// The DOM node right after this entry's nodes, so a component can re-insert its own nodes in place.
function nextNodeAfter(entry: Entry): Node | null {
  let current: Entry = entry;
  for (;;) {
    const parent: Container = current.parent;
    const siblings = parent.children;
    for (let i = siblings.indexOf(current) + 1; i < siblings.length; i++) {
      const node = firstNode(siblings[i]);
      if (node) return node;
    }
    if (parent.kind !== 'comp') return null;
    current = parent;
  }
}
function placeNodes(parent: Node, nodes: Node[], before: Node | null) {
  let cursor = before;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.parentNode !== parent || node.nextSibling !== cursor) parent.insertBefore(node, cursor);
    cursor = node;
  }
}
// Bumped whenever nodes are created, removed or reordered, so unchanged subtrees skip placement work.
let mutations = 0;
function appendNodes(parent: Node, entry: Entry) {
  if (entry.kind === 'comp') for (const child of entry.children) appendNodes(parent, child);
  else parent.appendChild(entry.node);
}

function domParent(container: Container): Node {
  return container.kind === 'comp' ? container.el : container.node;
}

function unmount(entry: Entry, removeDom: boolean) {
  mutations++;
  if (entry.kind === 'comp') {
    entry.disposed = true;
    entry.unsubs.forEach(u => u());
    entry.unsubs = [];
    dirty.delete(entry);
    entry.app.failed.delete(entry);
    for (const child of entry.children) unmount(child, removeDom);
    return;
  }
  if (entry.kind === 'el') {
    for (const child of entry.children) unmount(child, false);
    if (entry.props.ref) setRef(entry.props.ref, null);
  }
  if (removeDom) entry.node.parentNode?.removeChild(entry.node);
}

function shallowEqual(a: Props, b: Props) {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.is(a[k], b[k]));
}
const keyOfShallow = (s: Shallow) => typeof s === 'string' ? undefined : s.key;
const keyOfEntry = (e: Entry) => e.kind === 'text' ? undefined : e.key;
function compatible(entry: Entry, s: Shallow) {
  if (typeof s === 'string') return entry.kind === 'text';
  if (s.kind === 'el') return entry.kind === 'el' && entry.tag === s.tag;
  return entry.kind === 'comp' && entry.fn === s.fn;
}

function mount(s: Shallow, parent: Container, hy: Hydrator | null): Entry {
  mutations++;
  if (typeof s === 'string') return { kind: 'text', value: s, node: hy ? claimText(hy, s) : document.createTextNode(s), parent, app: parent.app, depth: parent.depth };
  if (s.kind === 'el') return mountElement(s, parent, hy);
  const entry: CompEntry = {
    kind: 'comp', fn: s.fn, key: s.key, props: s.props, children: [], svg: parent.svg, el: domParent(parent), parent, app: parent.app,
    depth: parent.depth + 1, deps: new Set(), extraDeps: [], unsubs: [], listener: () => invalidate(entry), dirty: false, disposed: false
  };
  renderComponent(entry, s.props, false, hy);
  return entry;
}

function mountElement(s: ShallowElement, parent: Container, hy: Hydrator | null): ElEntry {
  const svg = parent.svg || s.tag === 'svg';
  const el = hy ? claimElement(hy, s.tag, svg) : svg ? document.createElementNS(SVG_NS, s.tag) : document.createElement(s.tag);
  const entry: ElEntry = { kind: 'el', tag: s.tag, key: s.key, props: s.props, node: el, children: [], svg: svg && s.tag !== 'foreignObject', parent, app: parent.app, depth: parent.depth };
  const childHy = hy ? { parent: el, next: el.firstChild } : null;
  reconcileChildren(entry, s.children, childHy, false);
  if (childHy) finishHydration(childHy, s.tag);
  else for (const child of entry.children) appendNodes(el, child);
  applyProps(el, s.tag, s.props);
  return entry;
}

function patch(entry: Entry, s: Shallow, force: boolean) {
  if (entry.kind === 'text') {
    if (entry.value !== s) entry.node.data = s as string;
    entry.value = s as string;
  } else if (entry.kind === 'el') {
    const next = s as ShallowElement;
    const before = mutations;
    reconcileChildren(entry, next.children, null, force);
    if (mutations !== before) placeNodes(entry.node, entry.children.flatMap(c => domNodes(c)), null);
    applyProps(entry.node, next.tag, next.props, entry.props);
    entry.props = next.props;
    entry.key = next.key;
  } else {
    const next = s as ShallowComponent;
    entry.key = next.key;
    // Unchanged props and no signal changes: skip the component entirely.
    if (force || entry.dirty || !shallowEqual(entry.props, next.props)) renderComponent(entry, next.props, false, null, force);
  }
}

// Keyed diff of one container's children. DOM placement is left to the caller, because a
// component's nodes live inside an ancestor element alongside its siblings' nodes.
function reconcileChildren(container: Container, next: Shallow[], hy: Hydrator | null, force: boolean) {
  const old = container.children;
  if (!old.length) { container.children = next.map(s => mount(s, container, hy)); return; }
  const keyed = new Map<unknown, Entry>();
  for (const entry of old) { const key = keyOfEntry(entry); if (key != null) keyed.set(key, entry); }
  const used = new Set<Entry>();
  const seen = DEV ? new Set<unknown>() : undefined;
  const result = next.map((s, index) => {
    const key = keyOfShallow(s);
    if (seen && key != null) {
      if (seen.has(key)) warnOnce(`[IBU204] Two siblings share the key ${JSON.stringify(key)}; list items may be reused incorrectly. Use a unique id per item.\n  More: npx ibu explain IBU204`);
      seen.add(key);
    }
    let previous = key != null ? keyed.get(key) : old[index];
    if (key == null && previous && keyOfEntry(previous) != null) previous = undefined;
    if (previous && (used.has(previous) || !compatible(previous, s))) previous = undefined;
    if (!previous) return mount(s, container, hy);
    used.add(previous);
    patch(previous, s, force);
    return previous;
  });
  for (const entry of old) if (!used.has(entry)) unmount(entry, true);
  if (result.length !== old.length || result.some((entry, i) => entry !== old[i])) mutations++;
  container.children = result;
}

function subscribe(entry: CompEntry, deps: Set<Subscribable>) {
  entry.unsubs.forEach(u => u());
  entry.deps = deps;
  entry.unsubs = [...deps].map(d => d.subscribe(entry.listener));
}

// Renders one component in its own tracking scope. If it throws, its previous output stays on
// screen (a per-component error boundary) and the error is reported.
function renderComponent(entry: CompEntry, props: Props, self: boolean, hy: Hydrator | null, force = false) {
  entry.props = props;
  entry.dirty = false;
  dirty.delete(entry);
  const deps = new Set<Subscribable>(entry.extraDeps);
  const before = mutations;
  try {
    track(() => reconcileChildren(entry, flatten(entry.fn(props)), hy, force), deps);
  } catch (error) {
    if (error instanceof HydrationMismatch) throw error;
    subscribe(entry, new Set([...entry.deps, ...deps]));
    entry.app.failed.add(entry);
    entry.app.onError(error);
    return;
  }
  subscribe(entry, deps);
  if (entry.app.failed.delete(entry) && DEV && !entry.app.failed.size) document.getElementById(OVERLAY_ID)?.remove();
  if (self && mutations !== before) placeNodes(entry.el, domNodes(entry), nextNodeAfter(entry));
}

// ---- Scheduling: changed components re-render once per microtask, parents first ----

const dirty = new Set<CompEntry>();
let flushQueued = false;
function invalidate(entry: CompEntry) {
  if (entry.disposed) return;
  entry.dirty = true;
  dirty.add(entry);
  if (!flushQueued) { flushQueued = true; queueMicrotask(flush); }
}
function flush() {
  flushQueued = false;
  const queue = [...dirty].sort((a, b) => a.depth - b.depth);
  dirty.clear();
  for (const entry of queue) {
    if (entry.disposed || !entry.dirty) continue;
    try { countRender(); }
    catch (error) { dirty.clear(); entry.app.onError(error); return; }
    renderComponent(entry, entry.props, true, null);
  }
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
  el.textContent = `IbuJS could not render part of the page, so its last working version is still shown.\n\n${error instanceof Error ? error.message : String(error)}\n\n(This box only appears during development.)`;
}
function reportRenderError(error: unknown) {
  console.error(error);
  if (DEV && typeof document !== 'undefined') showOverlay(error);
}

let renders = 0, resetQueued = false;
function countRender() {
  if (!resetQueued) { resetQueued = true; setTimeout(() => { renders = 0; resetQueued = false; }, 0); }
  if (++renders > 10_000) {
    throw new IbuError('IBU203', 'Components re-rendered more than 10,000 times without pausing.', 'A component probably writes to a signal it reads while rendering. Move the write into an event handler or effect().');
  }
}

export interface App { update(): void; unmount(): void; root: Element }
export interface AppOptions { onError?: (error: unknown) => void }

function start(view: (() => Child) | Component, target: Element | string | null, options: AppOptions | Subscribable[], hydrating: boolean): App {
  const root = typeof target === 'string' ? document.querySelector(target) : target;
  if (!root) {
    throw new IbuError('IBU201', `The mount target ${typeof target === 'string' ? `"${target}" ` : ''}was not found.`, 'Add <div id="app"></div> to index.html and load your script with type="module" (which runs after the page is parsed).');
  }
  const app: AppState = { onError: (!Array.isArray(options) && options.onError) || reportRenderError, failed: new Set() };
  const container: RootEntry = { kind: 'root', node: root, children: [], svg: root.namespaceURI === SVG_NS && root.localName !== 'foreignObject', app, depth: 0 };
  const shallow: Shallow = { kind: 'comp', fn: view as Component, props: {}, key: undefined };
  const mountRoot = (hy: Hydrator | null) => {
    const entry = mount(shallow, container, hy) as CompEntry;
    container.children = [entry];
    if (hy) finishHydration(hy, root.localName);
    // v0.5 form: createApp(view, target, [signalA, signalB]) also re-renders on those signals.
    if (Array.isArray(options) && options.length) { entry.extraDeps = options; subscribe(entry, new Set([...entry.deps, ...options])); }
    placeNodes(root, domNodes(entry), null);
    return entry;
  };
  let rootEntry: CompEntry;
  if (hydrating && root.firstChild) {
    try { rootEntry = mountRoot({ parent: root, next: root.firstChild }); }
    catch (error) {
      if (!(error instanceof HydrationMismatch)) throw error;
      if (DEV) console.warn(`[IBU206] The server-rendered HTML did not match (${error.message}), so the page was rendered again in the browser.\n  More: npx ibu explain IBU206`);
      for (const entry of container.children) unmount(entry, false);
      root.replaceChildren();
      container.children = [];
      rootEntry = mountRoot(null);
    }
  } else {
    root.replaceChildren();
    rootEntry = mountRoot(null);
  }
  return {
    // Re-renders everything now, including components whose props did not change.
    update() { if (!rootEntry.disposed) renderComponent(rootEntry, rootEntry.props, true, null, true); },
    unmount() { unmount(rootEntry, true); root.replaceChildren(); container.children = []; },
    root
  };
}

// Renders view into target, replacing any existing content. target can be an element or a CSS selector.
export function createApp(view: (() => Child) | Component, target: Element | string | null, options: AppOptions | Subscribable[] = {}): App {
  return start(view, target, options, false);
}

// Like createApp, but adopts HTML rendered on the server by renderToString()/renderPage() instead of
// rebuilding it: no flash, and inputs keep focus. Falls back to a fresh render if the HTML differs.
export function hydrate(view: (() => Child) | Component, target: Element | string | null, options: AppOptions = {}): App {
  return start(view, target, options, true);
}

// Resolves after pending re-renders have been applied to the DOM.
export const nextTick = () => new Promise<void>(r => setTimeout(r, 0));
