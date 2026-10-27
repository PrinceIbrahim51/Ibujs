import { IbuError } from './errors.js';
import { signal } from './signals.js';
import { h, type Child, type Props } from './vnode.js';

export interface Route { path: string; component: (params: Record<string, string>) => Child }
export interface RouterOptions {
  // 'history' gives clean URLs (/about) and needs the server to send index.html for app routes.
  // 'hash' (/#/about) works on any static host and from file://.
  mode?: 'history' | 'hash';
  base?: string;
  scrollToTop?: boolean;
}

// '/users/:id' captures one segment; a trailing '/*' captures the rest as params['*'].
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const parts = pattern.split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  const wildcard = parts[parts.length - 1] === '*';
  if (wildcard ? actual.length < parts.length - 1 : parts.length !== actual.length) return null;
  const params: Record<string, string> = {};
  try {
    for (let i = 0; i < parts.length; i++) {
      if (wildcard && i === parts.length - 1) { params['*'] = actual.slice(i).map(decodeURIComponent).join('/'); break; }
      if (parts[i].startsWith(':')) params[parts[i].slice(1)] = decodeURIComponent(actual[i]);
      else if (parts[i] !== actual[i]) return null;
    }
  } catch { return null; }
  return params;
}

export function createRouter(routes: Route[], notFound: Route['component'] = () => 'Not found', options: RouterOptions = {}) {
  const hasWindow = typeof window !== 'undefined';
  const mode = options.mode ?? 'history';
  const base = (options.base ?? '').replace(/\/+$/, '');
  const read = () => {
    if (!hasWindow) return { path: '/', search: '' };
    if (mode === 'hash') {
      const url = new URL(window.location.hash.slice(1) || '/', 'http://ibu.invalid');
      return { path: url.pathname, search: url.search };
    }
    let path = window.location.pathname;
    if (base && (path === base || path.startsWith(base + '/'))) path = path.slice(base.length) || '/';
    return { path, search: window.location.search };
  };
  const initial = read();
  const path = signal(initial.path);
  const search = signal(initial.search);
  const sync = () => { const next = read(); path.value = next.path; search.value = next.search; };
  if (hasWindow) window.addEventListener(mode === 'hash' ? 'hashchange' : 'popstate', sync);

  const hrefFor = (to: string) => mode === 'hash' ? '#' + to : (to.startsWith('/') && !to.startsWith('//') ? base + to : to);

  const navigate = (to: string, opts: { replace?: boolean } = {}) => {
    if (!hasWindow) throw new IbuError('IBU302', 'router.navigate() needs a browser.', 'On the server, render the route you need directly.');
    const target = new URL(mode === 'hash' ? to : hrefFor(to), mode === 'hash' ? 'http://ibu.invalid' + path.peek() : window.location.href);
    if (mode !== 'hash' && target.origin !== window.location.origin) {
      throw new IbuError('IBU301', `Navigation to ${target.origin} was blocked: the router only navigates within this site.`, 'For external sites use a normal link: <a href="https://...">.');
    }
    const url = mode === 'hash' ? '#' + target.pathname + target.search : target.pathname + target.search + target.hash;
    window.history[opts.replace ? 'replaceState' : 'pushState']({}, '', url);
    sync();
    if (options.scrollToTop !== false && !target.hash && typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  };

  // <router.Link href="/about">About</router.Link>: a real link (works with middle-click, new tab,
  // and without JavaScript) that navigates in-app on a plain left click.
  const Link = (props: Props & { href: string }) => {
    const { href, children, onClick, ...rest } = props;
    return h('a', {
      ...rest,
      href: hrefFor(href),
      'aria-current': path.value === href ? 'page' : undefined,
      onClick: (event: MouseEvent) => {
        if (typeof onClick === 'function') onClick(event);
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || rest.target) return;
        event.preventDefault();
        navigate(href);
      }
    }, children);
  };

  return {
    path,
    search,
    Link,
    navigate,
    query: () => new URLSearchParams(search.value),
    isActive: (href: string) => path.value === href,
    view() {
      const current = path.value;
      for (const route of routes) {
        const params = matchRoute(route.path, current);
        if (params) return route.component(params);
      }
      return notFound({});
    },
    dispose() { if (hasWindow) window.removeEventListener(mode === 'hash' ? 'hashchange' : 'popstate', sync); }
  };
}
