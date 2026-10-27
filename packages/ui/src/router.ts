import { signal } from './index.js';
export interface Route { path: string; component: (params: Record<string, string>) => import('./index.js').Child }
export function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
  const parts = pattern.split('/').filter(Boolean);
  const actual = pathname.split('/').filter(Boolean);
  if (parts.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].startsWith(':')) {
      try { params[parts[i].slice(1)] = decodeURIComponent(actual[i]); } catch { return null; }
    } else if (parts[i] !== actual[i]) return null;
  }
  return params;
}
export function createRouter(routes: Route[], notFound: Route['component'] = () => 'Not found') {
  const path = signal(typeof window === 'undefined' ? '/' : window.location.pathname);
  const onPop = () => { path.value = window.location.pathname; };
  if (typeof window !== 'undefined') window.addEventListener('popstate', onPop);
  return {
    path,
    navigate(url: string) {
      if (typeof window === 'undefined') throw new Error('Navigation requires a browser');
      const next = new URL(url, window.location.href);
      if (next.origin !== window.location.origin) throw new Error('Cross-origin navigation denied');
      window.history.pushState({}, '', next.pathname + next.search + next.hash);
      path.value = next.pathname;
    },
    view() {
      const current = path.value;
      for (const route of routes) {
        const params = matchRoute(route.path, current);
        if (params) return route.component(params);
      }
      return notFound({});
    },
    dispose() { if (typeof window !== 'undefined') window.removeEventListener('popstate', onPop); }
  };
}
