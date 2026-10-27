import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { IbuError, isSafeHtml, matchRoute, type SafeHtml } from '@ibujs/ui';
import { parseCookies, serializeCookie, type CookieOptions } from './cookies.js';
import type { Schema } from './schema.js';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: { code?: string; [key: string]: unknown }) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface Context {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  requestId: string;
  // Client address; honours X-Forwarded-For only when `trustProxy` is set.
  ip: string;
  // True when the client connected over HTTPS (directly or via a trusted proxy).
  secure: boolean;
  // Per-request storage for middleware, e.g. ctx.state.user.
  state: Record<string, unknown>;
  json(data: unknown, status?: number): void;
  text(body: string, status?: number): void;
  html(page: SafeHtml, status?: number): void;
  empty(status?: number): void;
  redirect(location: string, options?: { status?: 301 | 302 | 303 | 307 | 308; allowExternal?: boolean }): void;
  // Reads and parses a JSON body (max `maxBodyBytes`). With a schema, returns validated, typed data.
  body<T = unknown>(schema?: Schema<T>): Promise<T>;
  cookies: { get(name: string): string | undefined; set(name: string, value: string, options?: CookieOptions): void; delete(name: string, options?: CookieOptions): void };
}
export type Handler = (ctx: Context) => void | Promise<void>;
export type Middleware = (ctx: Context, next: () => Promise<void>) => void | Promise<void>;
// app.post(path, handler) or app.post(path, rateLimit({ limit: 5 }), handler)
export type RouteArgs = [...middleware: Middleware[], handler: Handler];

export interface ServerOptions {
  maxBodyBytes?: number;
  // Set when running behind a reverse proxy/load balancer: true = one hop, or the number of hops.
  // On Vercel (VERCEL=1) this defaults to one hop, because every request arrives through its proxy.
  trustProxy?: boolean | number;
  // Adds error details to 500 responses. Defaults to NODE_ENV === 'development'.
  dev?: boolean;
  onError?: (error: unknown, ctx: Context) => void;
  // Cross-site request protection for POST/PUT/PATCH/DELETE (on by default). See csrf docs.
  csrf?: boolean | { trustedOrigins?: string[] };
  // Allow other origins to call this API from browsers. Origins must be listed explicitly.
  cors?: { origins: string[]; credentials?: boolean; methods?: string[]; headers?: string[]; maxAgeSeconds?: number };
  // Override (string) or remove (null) default response headers.
  headers?: Record<string, string | null>;
  // Content-Security-Policy for HTML responses.
  pageCsp?: string;
}

export const API_CSP = "default-src 'none'; frame-ancestors 'none'";
export const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const DEFAULT_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'X-XSS-Protection': '0',
  'Content-Security-Policy': API_CSP,
  'Cache-Control': 'no-store'
};
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const JSON_TYPE = 'application/json; charset=utf-8';
const PAGE_CSP_KEY = Symbol('pageCsp');
// Where app.listen() registers the request handler when a serverless platform runs the app.
export const SERVERLESS_HANDLER = Symbol.for('ibujs.handler');

// Drops keys that could pollute prototypes if the parsed object is later merged into another.
function safeReviver(key: string, value: unknown) {
  if (key === '__proto__') return undefined;
  if (key === 'constructor' && value && typeof value === 'object' && 'prototype' in value) return undefined;
  return value;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const tooLarge = () => new HttpError(413, `Request body is larger than ${limit} bytes`, { code: 'IBU401' });
  if (Number(req.headers['content-length']) > limit) return Promise.reject(tooLarge());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); req.off('aborted', onError); };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      // Stop reading instead of buffering an unbounded upload; the connection is closed after the 413.
      if (size > limit) { cleanup(); req.pause(); reject(tooLarge()); return; }
      chunks.push(chunk);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = () => { cleanup(); reject(new HttpError(400, 'Request body could not be read', { code: 'IBU414' })); };
    req.on('data', onData).on('end', onEnd).on('error', onError).on('aborted', onError);
  });
}

function clientAddress(req: IncomingMessage, hops: number): string {
  const socketIp = req.socket.remoteAddress ?? 'unknown';
  if (!hops) return socketIp;
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  // Each trusted proxy appends the address it saw; the client is `hops` entries from the right.
  const chain = [...forwarded, socketIp];
  return chain[Math.max(0, chain.length - 1 - hops)];
}

function isSameSite(location: string): boolean {
  try { return new URL(location, 'http://ibu.invalid').origin === 'http://ibu.invalid'; } catch { return false; }
}

interface RouteDef { method: string; path: string; handler: Handler }

export function createServer(options: ServerOptions = {}) {
  const exact = new Map<string, Handler>();
  const patterns: RouteDef[] = [];
  const allRoutes: RouteDef[] = [];
  const middleware: Middleware[] = [];
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const trustProxy = options.trustProxy ?? (process.env.VERCEL === '1' ? 1 : 0);
  const hops = trustProxy === true ? 1 : Number(trustProxy || 0);
  const dev = options.dev ?? process.env.NODE_ENV === 'development';
  const csrfEnabled = options.csrf !== false;
  const corsOrigins = new Set(options.cors?.origins ?? []);
  const trustedOrigins = new Set([...(typeof options.csrf === 'object' ? options.csrf.trustedOrigins ?? [] : []), ...corsOrigins]);
  if (corsOrigins.has('*') && options.cors?.credentials) {
    throw new IbuError('IBU406', 'cors: origins ["*"] cannot be combined with credentials: true.', 'List the exact origins that may send cookies, e.g. origins: ["https://app.example.com"].');
  }
  const headers = { ...DEFAULT_HEADERS };
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) delete headers[name]; else headers[name] = value;
  }
  const pageCsp = options.pageCsp ?? PAGE_CSP;
  const onError = options.onError ?? ((error: unknown, ctx: Context) => {
    // Deliberate HttpErrors get one line; unexpected errors get the full stack trace.
    const detail = error instanceof HttpError ? `${error.status} ${error.message}` : error;
    console.error(`[IbuJS] ${ctx.req.method} ${ctx.url.pathname} failed (request ${ctx.requestId}):`, detail);
  });

  const route = (method: string, path: string, fns: Array<Middleware | Handler>) => {
    if (!path.startsWith('/')) throw new IbuError('IBU405', `Route "${path}" must start with "/".`, `Write app.${method.toLowerCase()}('/${path}', ...).`);
    const handler = fns.pop() as Handler | undefined;
    if (typeof handler !== 'function') throw new IbuError('IBU405', `Route ${method} ${path} has no handler function.`);
    const chain = fns as Middleware[];
    const run: Handler = chain.length ? ctx => compose([...chain, (c: Context) => handler(c)])(ctx) : handler;
    const key = `${method} ${path}`;
    if (exact.has(key) || patterns.some(r => r.method === method && r.path === path)) {
      throw new IbuError('IBU405', `Route ${key} is defined twice.`, 'Remove or rename one of them.');
    }
    const def = { method, path, handler: run };
    allRoutes.push(def);
    if (/\/[:*]/.test(path)) patterns.push(def); else exact.set(key, run);
  };

  const find = (method: string, pathname: string): { handler: Handler; params: Record<string, string> } | undefined => {
    const hit = exact.get(`${method} ${pathname}`);
    if (hit) return { handler: hit, params: {} };
    for (const r of patterns) {
      if (r.method !== method) continue;
      const params = matchRoute(r.path, pathname);
      if (params) return { handler: r.handler, params };
    }
  };

  const handler: http.RequestListener = async (req, res) => {
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    const requestId = randomUUID();
    res.setHeader('X-Request-ID', requestId);
    const rawUrl = req.url ?? '/';
    let url: URL;
    try {
      // Prefixing (instead of passing a base) keeps "//evil.com/x" a path rather than a new host.
      if (!rawUrl.startsWith('/')) throw new Error('bad target');
      url = new URL('http://ibu.invalid' + rawUrl);
    } catch {
      res.writeHead(400, { 'Content-Type': JSON_TYPE }).end(JSON.stringify({ error: 'Bad request target', code: 'IBU413' }));
      return;
    }
    const forwardedProto = hops ? String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() : '';
    const secure = Boolean((req.socket as { encrypted?: boolean }).encrypted) || forwardedProto === 'https';
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    let cookies: Record<string, string> | undefined;
    let bodyPromise: Promise<unknown> | undefined;
    const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const ctx: Context = {
      req, res, url, requestId, secure,
      params: {},
      query: url.searchParams,
      ip: clientAddress(req, hops),
      state: {},
      json(data, status = 200) { send(status, JSON_TYPE, JSON.stringify(data)); },
      text(body, status = 200) { send(status, 'text/plain; charset=utf-8', body); },
      html(page, status = 200) {
        if (!isSafeHtml(page)) {
          throw new IbuError('IBU407', 'ctx.html() only accepts HTML built with html`...`, renderPage() or renderToString().', 'Those helpers escape user data; a plain string could contain an injected <script>.');
        }
        send(status, 'text/html; charset=utf-8', page.toString(), { 'Content-Security-Policy': pageCsp });
      },
      empty(status = 204) { if (!res.writableEnded) { res.writeHead(status); res.end(); } },
      redirect(location, opts = {}) {
        if (!opts.allowExternal && !isSameSite(location)) {
          throw new IbuError('IBU408', `Refusing to redirect to another site: ${JSON.stringify(location)}.`, 'Redirect to a path like "/dashboard". If the target is a trusted external site, pass { allowExternal: true } and validate it against an allowlist first.');
        }
        if (res.writableEnded) return;
        res.writeHead(opts.status ?? 302, { Location: location });
        res.end();
      },
      body<T>(schema?: Schema<T>): Promise<T> {
        bodyPromise ??= (async () => {
          const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
          if (type !== 'application/json') throw new HttpError(415, 'Expected Content-Type: application/json', { code: 'IBU402' });
          const raw = await readBody(req, maxBodyBytes);
          try { return JSON.parse(raw.toString('utf8'), safeReviver); }
          catch { throw new HttpError(400, 'Request body is not valid JSON', { code: 'IBU403' }); }
        })();
        return bodyPromise.then(value => schema ? schema.parse(value) : value as T);
      },
      cookies: {
        get: name => (cookies ??= parseCookies(req.headers.cookie))[name],
        set: (name, value, cookieOptions = {}) => {
          const existing = res.getHeader('Set-Cookie');
          const list = Array.isArray(existing) ? existing : existing ? [String(existing)] : [];
          res.setHeader('Set-Cookie', [...list, serializeCookie(name, value, { secure, ...cookieOptions })]);
        },
        delete: (name, cookieOptions = {}) => ctx.cookies.set(name, '', { ...cookieOptions, maxAge: 0 })
      }
    };
    (ctx as unknown as Record<symbol, string>)[PAGE_CSP_KEY] = pageCsp;

    try {
      const method = req.method === 'HEAD' ? 'GET' : req.method ?? 'GET';
      const origin = req.headers.origin;
      if (corsOrigins.size && origin) applyCors(ctx, origin);
      if (req.method === 'OPTIONS' && corsOrigins.size && origin && req.headers['access-control-request-method']) { ctx.empty(204); return; }
      if (csrfEnabled && !SAFE_METHODS.has(req.method ?? 'GET')) checkCrossSite(ctx, trustedOrigins, hops);
      const match = find(method, url.pathname);
      if (match) ctx.params = match.params;
      const endpoint: Handler = match?.handler ?? (c => {
        const allowed = [...new Set(allRoutes.filter(r => matchRoute(r.path, url.pathname)).map(r => r.method))];
        if (allowed.length) {
          if (allowed.includes('GET')) allowed.push('HEAD');
          res.setHeader('Allow', allowed.join(', '));
          c.json({ error: `Method ${req.method} not allowed`, code: 'IBU409' }, 405);
        } else c.json({ error: 'Not found', code: 'IBU404' }, 404);
      });
      await compose([...middleware, (c: Context) => endpoint(c)])(ctx);
      if (!res.writableEnded && !res.headersSent) {
        const error = new IbuError('IBU410', `${req.method} ${url.pathname} finished without sending a response.`, 'Return a response, e.g. ctx.json({ ok: true }), and await any async work before it.');
        onError(error, ctx);
        ctx.json({ error: 'Internal server error', requestId, ...(dev ? { debug: error.message } : {}) }, 500);
      }
    } catch (err) {
      const status = errorStatus(err);
      if (status >= 500) onError(err, ctx);
      if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
      if (status === 413) res.setHeader('Connection', 'close');
      const code = (err as { details?: { code?: string } }).details?.code ?? (err instanceof IbuError ? err.code : undefined);
      // HttpErrors are messages you wrote for users, so they are shown. Anything else that fails
      // with a 5xx is unexpected and may contain internals, so only the request id is returned.
      const exposed = err instanceof HttpError || status < 500;
      const body: Record<string, unknown> = exposed
        ? { error: err instanceof Error ? err.message : 'Request failed', ...(code ? { code } : {}), ...(status >= 500 ? { requestId } : {}) }
        : { error: 'Internal server error', requestId, ...(dev ? { debug: err instanceof Error ? err.message : String(err) } : {}) };
      const issues = (err as { issues?: unknown }).issues;
      if (exposed && issues) body.issues = issues;
      if (!res.writableEnded) ctx.json(body, status);
    }
  };

  function applyCors(ctx: Context, origin: string) {
    if (!corsOrigins.has(origin) && !corsOrigins.has('*')) return;
    const res = ctx.res;
    res.setHeader('Access-Control-Allow-Origin', corsOrigins.has('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    if (options.cors?.credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
    if (ctx.req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', (options.cors?.methods ?? ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).join(', '));
      res.setHeader('Access-Control-Allow-Headers', (options.cors?.headers ?? ['Content-Type']).join(', '));
      res.setHeader('Access-Control-Max-Age', String(options.cors?.maxAgeSeconds ?? 600));
    }
  }

  const add = (method: string) => (path: string, ...fns: RouteArgs) => route(method, path, [...fns]);
  return {
    get: add('GET'),
    post: add('POST'),
    put: add('PUT'),
    patch: add('PATCH'),
    delete: add('DELETE'),
    use: (fn: Middleware) => { middleware.push(fn); },
    listen(port = 3000, host = '127.0.0.1') {
      const server = http.createServer(handler);
      // Short timeouts limit slow-client (slowloris) attacks.
      server.headersTimeout = 20_000;
      server.requestTimeout = 60_000;
      server.keepAliveTimeout = 5_000;
      server.maxHeadersCount = 100;
      // On serverless platforms (ibu build --target=vercel) the platform calls the handler itself.
      if (process.env.IBU_SERVERLESS === '1') {
        (globalThis as Record<symbol, unknown>)[SERVERLESS_HANDLER] = handler;
        return server;
      }
      return server.listen(port, host);
    },
    handler
  };
}

function compose(fns: Middleware[]): Handler {
  return ctx => {
    let index = -1;
    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) throw new IbuError('IBU411', 'next() was called more than once in a middleware.');
      index = i;
      if (i < fns.length) await fns[i](ctx, () => dispatch(i + 1));
    };
    return dispatch(0);
  };
}

function errorStatus(err: unknown): number {
  const status = Number((err as { status?: unknown } | null)?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

// Blocks cross-site form posts and fetches, following the Fetch Metadata approach
// (the same algorithm as Go's http.CrossOriginProtection). Non-browser clients are unaffected.
function checkCrossSite(ctx: Context, trusted: Set<string>, hops: number) {
  const site = ctx.req.headers['sec-fetch-site'];
  const origin = ctx.req.headers.origin;
  if (site === 'same-origin' || site === 'none') return;
  if (origin && trusted.has(origin)) return;
  if (!site) {
    if (!origin) return;
    const host = (hops && ctx.req.headers['x-forwarded-host']) || ctx.req.headers.host;
    try { if (new URL(origin).host === host) return; } catch { /* malformed Origin */ }
  }
  throw new HttpError(403, 'Cross-site request blocked', { code: 'IBU412' });
}

export function pageCspOf(ctx: Context): string {
  return (ctx as unknown as Record<symbol, string>)[PAGE_CSP_KEY] ?? PAGE_CSP;
}
