import { IbuError, reportViolation } from './errors.js';

// Shared by the DOM renderer and renderToString, so server and browser enforce the same rules.

export const BLOCKED_URL = 'about:blank#blocked';
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:']);
// Attributes a browser may navigate to, load, or submit to.
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'background', 'cite', 'data', 'codebase', 'manifest', 'longdesc', 'lowsrc', 'dynsrc', 'icon', 'profile', 'classid', 'archive', 'ping']);
const MEDIA_DATA_URL = /^data:(?:image\/(?:png|gif|jpe?g|webp|avif|bmp|x-icon)|video\/(?:mp4|webm|ogg)|audio\/(?:mpeg|mp4|ogg|wav|webm))[;,]/i;
// <script> runs code when inserted by createElement; <base> silently re-points every relative URL.
const BLOCKED_TAGS = new Set(['script', 'base']);
const RAW_HTML_PROPS = new Set(['innerhtml', 'outerhtml', 'dangerouslysetinnerhtml', 'srcdoc', 'insertadjacenthtml']);
const TAG_NAME = /^[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*$/;
const ATTRIBUTE_NAME = /^[a-zA-Z_][\w.:-]*$/;

function preview(value: string) {
  return JSON.stringify(value.length > 60 ? value.slice(0, 60) + '…' : value);
}

function isMediaSource(tag: string, attr: string) {
  return (attr === 'src' && ['img', 'source', 'video', 'audio', 'track', 'input'].includes(tag))
    || (attr === 'poster' && tag === 'video')
    || ((attr === 'href' || attr === 'xlink:href') && tag === 'image');
}

// Parses the URL exactly like the browser will (stripping tabs, newlines and leading control
// characters), then allows only known-safe schemes. Relative URLs always pass: they inherit the
// page's own scheme.
export function isSafeUrl(value: string, tag = 'a', attr = 'href'): boolean {
  let url: URL;
  try { url = new URL(value, 'http://ibu.invalid/'); } catch { return false; }
  if (SAFE_PROTOCOLS.has(url.protocol)) return true;
  if (isMediaSource(tag.toLowerCase(), attr.toLowerCase())) {
    if (url.protocol === 'blob:') return true;
    if (url.protocol === 'data:') return MEDIA_DATA_URL.test(url.href);
  }
  return false;
}

export function checkTag(tag: string) {
  if (!TAG_NAME.test(tag)) throw new IbuError('IBU104', `"${tag}" is not a valid element name.`, 'Element names are letters and digits, optionally with dashes (my-widget).');
  if (BLOCKED_TAGS.has(tag.toLowerCase())) {
    throw new IbuError('IBU103', `<${tag}> elements cannot be rendered by IbuJS.`, tag.toLowerCase() === 'script'
      ? 'Put scripts in index.html or import them as modules; rendering scripts from components is a common XSS vector.'
      : '<base> changes how every relative URL on the page resolves; set it in index.html if you really need it.');
  }
}

export const isEventProp = (key: string) => /^on[A-Z]/.test(key);

// Throws for props that can never be safe, whatever their value. Called before the DOM is touched.
export function checkProp(tag: string, key: string, value: unknown) {
  if (key === 'children' || key === 'key' || key === 'ref' || key === 'bind') return;
  const lower = key.toLowerCase();
  if (RAW_HTML_PROPS.has(lower)) {
    throw new IbuError('IBU102', `<${tag} ${key}> would inject raw HTML, which IbuJS never does.`, 'Render text and elements as children instead. For user-written rich text, convert it to elements (e.g. a Markdown renderer that outputs IbuJS nodes).');
  }
  if (lower.startsWith('on') && !(isEventProp(key) && (typeof value === 'function' || value == null))) {
    throw new IbuError('IBU102', `<${tag} ${key}=${typeof value === 'string' ? preview(value) : typeof value}> is an inline event handler string.`, `Pass a function: ${isEventProp(key) ? key : 'on' + key.slice(2, 3).toUpperCase() + key.slice(3)}={() => doSomething()}.`);
  }
  if (lower === 'http-equiv' || lower === 'httpequiv') {
    throw new IbuError('IBU102', `<${tag} ${key}> is blocked because it can redirect or reconfigure the page.`, 'Set <meta http-equiv> in index.html instead.');
  }
  if (!ATTRIBUTE_NAME.test(key)) {
    throw new IbuError('IBU104', `"${key}" is not a valid attribute name on <${tag}>.`);
  }
}

// Returns a value that is safe to put in the attribute. Unsafe URLs are replaced and reported,
// never thrown, so hostile data cannot crash the page.
export function sanitizeAttribute(tag: string, attr: string, value: string): string {
  const name = attr.toLowerCase();
  if (URL_ATTRIBUTES.has(name) && !isSafeUrl(value, tag, name)) {
    reportViolation({ code: 'IBU101', message: `Blocked an unsafe URL in <${tag} ${attr}>: ${preview(value)}. Only http(s), mailto, tel, sms and relative URLs are allowed${isMediaSource(tag, name) ? ' (plus blob: and image/audio/video data: URLs here)' : ''}.`, tag, attribute: attr, value });
    return BLOCKED_URL;
  }
  // SVG <animate>/<set> can rewrite href to a javascript: URL after sanitisation.
  if (name === 'attributename' && /^\s*(?:xlink:)?href\s*$/i.test(value)) {
    reportViolation({ code: 'IBU101', message: `Blocked <${tag} attributeName="${value.trim()}">: animating href can smuggle in a javascript: URL.`, tag, attribute: attr, value });
    return 'data-ibu-blocked';
  }
  return value;
}

export type ClassValue = string | number | boolean | null | undefined | ClassValue[] | Record<string, unknown>;
// class={['btn', active && 'active']} or class={{ btn: true, active }} → "btn active"
export function classNames(value: ClassValue): string {
  if (value == null || value === false || value === true) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(classNames).filter(Boolean).join(' ');
  return Object.keys(value).filter(k => value[k]).join(' ');
}

export const cssName = (name: string) => name.startsWith('--') ? name : name.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
