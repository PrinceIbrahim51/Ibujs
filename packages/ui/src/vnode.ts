import { IbuError } from './errors.js';
import { checkProp, checkTag } from './security.js';
import { isSignal } from './signals.js';

// Elements are branded with a Symbol. JSON cannot contain Symbols, so data from an API or a
// database can never be mistaken for an element (and can never smuggle in a <script>).
export const ELEMENT: unique symbol = Symbol.for('ibujs.element');

export type Child = VNode | string | number | bigint | boolean | null | undefined | { readonly value: unknown } | Child[];
export type Props = Record<string, unknown> & { children?: Child; key?: string | number };
export type Component<P = any> = (props: P) => Child;
export interface VNode { readonly [ELEMENT]: true; type: string | Component; props: Props }

export function h(type: VNode['type'], props?: Props | null, ...children: Child[]): VNode {
  return { [ELEMENT]: true, type, props: { ...(props ?? {}), ...(children.length ? { children } : {}) } };
}
export const Fragment = (props: { children?: Child }): Child => props.children ?? null;

export function isVNode(value: unknown): value is VNode {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[ELEMENT] === true;
}

// A fully resolved tree: components called, signals read, fragments flattened, names validated.
export interface ResolvedElement { tag: string; props: Props; children: ResolvedNode[] }
export type ResolvedNode = string | ResolvedElement;

function describe(value: unknown) {
  if (typeof value === 'function') return `function ${value.name || '(anonymous)'}`;
  try { const json = JSON.stringify(value); return json.length > 60 ? json.slice(0, 60) + '…' : json; } catch { return Object.prototype.toString.call(value); }
}

export function resolve(child: unknown, out: ResolvedNode[] = []): ResolvedNode[] {
  if (child == null || typeof child === 'boolean') return out;
  if (typeof child === 'string') { out.push(child); return out; }
  if (typeof child === 'number' || typeof child === 'bigint') { out.push(String(child)); return out; }
  if (Array.isArray(child)) { for (const c of child) resolve(c, out); return out; }
  if (isVNode(child)) {
    const { type, props } = child;
    if (typeof type === 'function') {
      const start = out.length;
      resolve(type(props), out);
      // <Item key={id} /> keys the element Item returns, so lists of components diff by key.
      const single = out.length === start + 1 ? out[start] : undefined;
      if (props.key != null && typeof single === 'object' && single.props.key == null) {
        out[start] = { ...single, props: { ...single.props, key: props.key } };
      }
      return out;
    }
    checkTag(type);
    for (const key of Object.keys(props)) checkProp(type, key, props[key]);
    out.push({ tag: type, props, children: resolve(props.children) });
    return out;
  }
  // {count} renders the signal's current value and re-renders when it changes.
  if (isSignal(child)) return resolve(child.value, out);
  if (typeof child === 'function') {
    throw new IbuError('IBU105', `A ${describe(child)} was used as a child.`, 'Call it ({renderList()}) or render it as a component (<RenderList />).');
  }
  throw new IbuError('IBU106', `Objects cannot be rendered as children (got ${describe(child)}).`, 'Render a field such as {item.title}, or {JSON.stringify(value)} to show raw data.');
}
