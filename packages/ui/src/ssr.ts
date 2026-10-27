import { IbuError } from './errors.js';
import { classNames, cssName, isEventProp, sanitizeAttribute, type ClassValue } from './security.js';
import { isSignal } from './signals.js';
import { resolve, type Child, type ResolvedNode } from './vnode.js';

const TOKEN = Symbol('ibujs.safe-html');

// A string of HTML that IbuJS produced or escaped itself. Only SafeHtml is ever written as raw
// HTML; every plain string is escaped. Only this module can create one, so there is no way to
// wrap arbitrary input and no "trust me" escape hatch.
export class SafeHtml {
  readonly #html: string;
  constructor(token: symbol, html: string) {
    if (token !== TOKEN) throw new IbuError('IBU109', 'SafeHtml cannot be created directly.', 'Build HTML with the html`` template or renderToString(); both escape their inputs.');
    this.#html = html;
  }
  toString() { return this.#html; }
  static isSafeHtml(value: unknown): value is SafeHtml {
    return typeof value === 'object' && value !== null && #html in value;
  }
}
export const isSafeHtml = SafeHtml.isSafeHtml;
const trusted = (markup: string) => new SafeHtml(TOKEN, markup);

export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// html`<p>${userText}</p>` escapes every interpolation unless it is already SafeHtml.
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  values.forEach((value, i) => { out += interpolate(value) + strings[i + 1]; });
  return trusted(out);
}
function interpolate(value: unknown): string {
  if (value == null || value === false) return '';
  if (Array.isArray(value)) return value.map(interpolate).join('');
  if (isSafeHtml(value)) return value.toString();
  return escapeHtml(value);
}

const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BOOLEAN_PROPS = new Set(['checked', 'selected', 'disabled', 'readonly', 'required', 'multiple', 'hidden', 'open', 'autofocus', 'muted', 'novalidate']);

function styleText(style: unknown): string {
  if (typeof style === 'string') return style;
  if (!style || typeof style !== 'object') return '';
  return Object.entries(style)
    .filter(([, v]) => v != null && v !== false)
    .map(([k, v]) => `${cssName(k)}:${typeof v === 'number' && v !== 0 && !/^(opacity|zIndex|flex|flexGrow|flexShrink|order|fontWeight|lineHeight|zoom)$/.test(k) ? v + 'px' : v}`)
    .join(';');
}

function attributes(tag: string, props: Record<string, unknown>): string {
  let out = '';
  for (const [key, raw] of Object.entries(props)) {
    if (key === 'children' || key === 'key' || key === 'ref' || isEventProp(key)) continue;
    let name = key === 'className' ? 'class' : key === 'htmlFor' ? 'for' : key;
    let value: unknown = raw;
    if (key === 'bind') {
      if (!isSignal(raw)) continue;
      name = props.type === 'checkbox' || props.type === 'radio' ? 'checked' : 'value';
      value = name === 'checked' ? (props.type === 'radio' ? raw.value === props.value : !!raw.value) : raw.value;
      if (tag === 'textarea') continue;
    }
    if (name === 'class') value = classNames(raw as ClassValue) || null;
    if (name === 'style') value = styleText(raw) || null;
    if (value == null || value === false) continue;
    if (value === true || (BOOLEAN_PROPS.has(name.toLowerCase()) && value)) { out += ' ' + name; continue; }
    out += ` ${name}="${escapeHtml(sanitizeAttribute(tag, name, String(value)))}"`;
  }
  return out;
}

function serialize(node: ResolvedNode): string {
  if (typeof node === 'string') return escapeHtml(node);
  const { tag, props, children } = node;
  const open = `<${tag}${attributes(tag, props)}>`;
  if (VOID.has(tag.toLowerCase())) return open;
  if (tag.toLowerCase() === 'style') {
    // <style> content is raw text: a "</" inside it could close the tag and start real HTML.
    const css = children.map(c => typeof c === 'string' ? c : '').join('');
    if (/<\//.test(css)) throw new IbuError('IBU108', '<style> content contains "</", which could break out of the style element.', 'Do not put user input inside <style>; use the style prop for dynamic values.');
    return open + css + `</${tag}>`;
  }
  let inner = children.map(serialize).join('');
  if (tag.toLowerCase() === 'textarea' && isSignal(props.bind)) inner = escapeHtml(props.bind.value ?? '');
  return open + inner + `</${tag}>`;
}

// Renders JSX to an HTML string on the server with the same safety rules as the browser renderer.
export function renderToString(view: Child | (() => Child)): SafeHtml {
  const tree = resolve(typeof view === 'function' ? (view as () => Child)() : view);
  return trusted(tree.map(serialize).join(''));
}
