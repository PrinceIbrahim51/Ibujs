import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
export * from './security.js';
export * from './auth.js';
export * from './db.js';

export type Context = { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string,string>; requestId?: string; json: (data: unknown, status?: number) => void; body: <T = unknown>() => Promise<T> };
export type Handler = (ctx: Context) => void | Promise<void>;
export type Middleware = (ctx: Context, next: () => Promise<void>) => void | Promise<void>;
export function createServer(options: { maxBodyBytes?: number } = {}) {
  const routes = new Map<string, Handler>();
  const patterns: Array<{method:string;path:string;handler:Handler}> = [];
  const middleware: Middleware[] = [];
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const route = (method: string, path: string, handler: Handler) => {
    if (!path.startsWith('/')) throw new Error('Route must begin with /');
    routes.set(`${method} ${path}`, handler);
    if (path.includes(':')) patterns.push({method,path,handler});
  };
  const handler: http.RequestListener = async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const ctx: Context = {
      req, res, url, params: {},
      json(data, status = 200) { if (res.writableEnded) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); },
      async body<T>() {
        const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (contentType !== 'application/json') throw Object.assign(new Error('Expected application/json'), { status: 415 });
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { const buf = Buffer.from(chunk); size += buf.length; if (size > maxBodyBytes) throw Object.assign(new Error('Request body too large'), { status: 413 }); chunks.push(buf); }
        try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T; }
        catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
      }
    };
    let matched = routes.get(`${req.method} ${url.pathname}`);
    if(!matched)for(const r of patterns){if(r.method!==req.method)continue;const a=r.path.split('/').filter(Boolean),b=url.pathname.split('/').filter(Boolean);if(a.length!==b.length)continue;const params:Record<string,string>={};let ok=true;for(let i=0;i<a.length;i++){if(a[i].startsWith(':')){try{params[a[i].slice(1)]=decodeURIComponent(b[i]);}catch{ok=false;break;}}else if(a[i]!==b[i]){ok=false;break;}}if(ok){ctx.params=params;matched=r.handler;break;}}
    const endpoint: Handler = matched ?? ((c) => c.json({ error: 'Not found' }, 404));
    try {
      let index = -1;
      const dispatch = async (i: number): Promise<void> => {
        if (i <= index) throw new Error('next() called multiple times'); index = i;
        if (i === middleware.length) { await endpoint(ctx); return; }
        await middleware[i](ctx, () => dispatch(i + 1));
      };
      await dispatch(0);
      if (!res.writableEnded) ctx.json({ error: 'Handler did not send a response' }, 500);
    } catch (err) {
      if (res.writableEnded) return;
      const status = typeof err === 'object' && err !== null && 'status' in err && [400, 401, 403, 413, 415, 422, 429].includes(Number(err.status)) ? Number(err.status) : 500;
      ctx.json({ error: status === 500 ? 'Internal server error' : (err as Error).message }, status);
    }
  };
  return {
    get: (path: string, fn: Handler) => route('GET', path, fn),
    post: (path: string, fn: Handler) => route('POST', path, fn),
    put: (path: string, fn: Handler) => route('PUT', path, fn),
    delete: (path: string, fn: Handler) => route('DELETE', path, fn),
    use: (fn: Middleware) => { middleware.push(fn); },
    listen: (port = 3000, host = '127.0.0.1') => http.createServer(handler).listen(port, host),
    handler
  };
}

export * from './ssr.js';
