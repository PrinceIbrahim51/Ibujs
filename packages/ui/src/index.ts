export type Child = VNode | string | number | boolean | null | undefined | Child[];
export type Props = Record<string, unknown> & { children?: Child; key?: string | number };
export interface VNode { type: string | ((props: Props) => Child); props: Props; }
export function h(type: VNode['type'], props: Props | null, ...children: Child[]): VNode {
  return { type, props: { ...(props ?? {}), ...(children.length ? { children } : {}) } };
}
type Subscriber = () => void;
type SignalLike = { subscribe(fn: Subscriber): () => void };
let tracking: Set<SignalLike> | null = null;
export function signal<T>(initial: T) {
  let value = initial;
  const listeners = new Set<Subscriber>();
  return {
    get value() { tracking?.add(this); return value; },
    set value(next: T) { if (!Object.is(next, value)) { value = next; for (const fn of [...listeners]) fn(); } },
    subscribe(fn: Subscriber) { listeners.add(fn); return () => { listeners.delete(fn); }; }
  };
}
const unsafeUrl = /^(?:\s*(?:javascript|vbscript|data):)/i;
function setProp(el: Element, key: string, val: unknown, old?: unknown) {
  if (key === 'children' || key === 'key' || key === 'ref') return;
  if (key === 'dangerouslySetInnerHTML' || key === 'innerHTML' || /^on/i.test(key) && !/^on[A-Z]/.test(key)) throw new Error('Unsafe property: ' + key);
  if (/^on[A-Z]/.test(key)) {
    const event = key.slice(2).toLowerCase();
    if (typeof old === 'function') el.removeEventListener(event, old as EventListener);
    if (typeof val === 'function') el.addEventListener(event, val as EventListener);
    return;
  }
  if (key === 'style') {
    if (val != null && (typeof val !== 'object' || Array.isArray(val))) throw new Error('Style must be an object');
    if (old && typeof old === 'object') for (const name of Object.keys(old)) (el as HTMLElement).style.removeProperty(name.replace(/[A-Z]/g, x => '-' + x.toLowerCase()));
    if (val) Object.assign((el as HTMLElement).style, val);
    return;
  }
  const attr = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key;
  if (val == null || val === false) { el.removeAttribute(attr); return; }
  if (/^(href|src|action|formaction|xlink:href)$/i.test(attr) && unsafeUrl.test(String(val))) throw new Error('Unsafe URL');
  if (val === true) el.setAttribute(attr, '');
  else el.setAttribute(attr, String(val));
}
function normalize(child: Child): Array<VNode | string> {
  if (child == null || typeof child === 'boolean') return [];
  if (Array.isArray(child)) return child.flatMap(normalize);
  if (typeof child !== 'object') return [String(child)];
  if (typeof child.type === 'function') return normalize(child.type(child.props));
  return [child];
}
type Entry = { vnode: VNode | string; node: Node; children: Entry[] };
function mount(vnode: VNode | string): Entry {
  if (typeof vnode === 'string') return { vnode, node: document.createTextNode(vnode), children: [] };
  const el = document.createElement(vnode.type as string);
  for (const [key, val] of Object.entries(vnode.props)) setProp(el, key, val);
  const children = normalize(vnode.props.children).map(mount);
  el.append(...children.map(x => x.node));
  return { vnode, node: el, children };
}
function reconcile(parent: Node, old: Entry[], next: Array<VNode | string>): Entry[] {
  const oldKeys = new Map<string | number, Entry>();
  for (const entry of old) if (typeof entry.vnode !== 'string' && entry.vnode.props.key != null) oldKeys.set(entry.vnode.props.key as string | number, entry);
  const used = new Set<Entry>();
  const result = next.map((vnode, index) => {
    const key = typeof vnode !== 'string' ? vnode.props.key : undefined;
    let previous = key != null ? oldKeys.get(key) : old[index];
    if (key == null && previous && typeof previous.vnode !== 'string' && previous.vnode.props.key != null) previous = undefined;
    if (previous && used.has(previous)) previous = undefined;
    if (previous) used.add(previous);
    if (!previous || typeof previous.vnode !== typeof vnode || (typeof vnode !== 'string' && typeof previous.vnode !== 'string' && previous.vnode.type !== vnode.type)) return mount(vnode);
    if (typeof vnode === 'string' && typeof previous.vnode === 'string') {
      if (previous.vnode !== vnode) previous.node.textContent = vnode;
      previous.vnode = vnode;
      return previous;
    }
    if (typeof vnode !== 'string' && typeof previous.vnode !== 'string') {
      const el = previous.node as Element;
      for (const key of new Set([...Object.keys(previous.vnode.props), ...Object.keys(vnode.props)])) {
        if (!Object.is(previous.vnode.props[key], vnode.props[key])) setProp(el, key, vnode.props[key], previous.vnode.props[key]);
      }
      previous.children = reconcile(el, previous.children, normalize(vnode.props.children));
      previous.vnode = vnode;
    }
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
export function createApp(view: () => Child, target: Element, dependencies: SignalLike[] = []) {
  let disposed = false;
  let entries: Entry[] = [];
  let unsubs: Array<() => void> = [];
  let updating = false;
  const update = () => {
    if (disposed || updating) return;
    updating = true;
    try {
      const observed = new Set<SignalLike>(dependencies);
      const previous = tracking;
      tracking = observed;
      let vnodes: Array<VNode | string>;
      try { vnodes = normalize(view()); } finally { tracking = previous; }
      entries = reconcile(target, entries, vnodes);
      unsubs.forEach(fn => fn());
      unsubs = [...observed].map(dep => dep.subscribe(update));
    } finally { updating = false; }
  };
  update();
  return { update, unmount() { disposed = true; unsubs.forEach(fn => fn()); target.replaceChildren(); entries = []; } };
}

export { effect, onCleanup, disposeEffects } from './lifecycle.js';
export { createRouter, matchRoute } from './router.js';
export { api } from './api.js';
