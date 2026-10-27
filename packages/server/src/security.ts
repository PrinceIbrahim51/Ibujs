import { HttpError, type Context, type Middleware } from './app.js';

// Request IDs are now built in (every response has X-Request-ID and ctx.requestId);
// this no-op is kept so v0.5 code that calls app.use(requestIds()) keeps working.
export function requestIds(): Middleware { return (_ctx, next) => next(); }

// IPv6 users usually control a whole /64, so limit per /64 rather than per address.
export function rateLimitKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return full.slice(0, 4).map(part => part.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

export interface RateLimitOptions {
  windowMs?: number;
  limit?: number;
  // Group requests by something other than client IP, e.g. ctx => 'login:' + ctx.ip.
  key?: (ctx: Context) => string;
  // Memory cap: the oldest entries are evicted beyond this many tracked clients.
  maxKeys?: number;
}

// In-memory, per-process limiter. Behind a proxy, set createServer({ trustProxy: true }) so ctx.ip is the
// real client; with several server processes, use a shared store (e.g. Redis) instead.
export function rateLimit(options: RateLimitOptions = {}): Middleware {
  const windowMs = options.windowMs ?? 60_000, limit = options.limit ?? 60, maxKeys = options.maxKeys ?? 10_000;
  const buckets = new Map<string, { count: number; until: number }>();
  return (ctx, next) => {
    const now = Date.now();
    const key = options.key ? options.key(ctx) : rateLimitKey(ctx.ip);
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (bucket) buckets.delete(key);
      if (buckets.size >= maxKeys) {
        for (const [k, v] of buckets) if (v.until <= now) buckets.delete(k);
        for (const k of buckets.keys()) { if (buckets.size < maxKeys) break; buckets.delete(k); }
      }
      bucket = { count: 0, until: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    const reset = Math.ceil((bucket.until - now) / 1000);
    ctx.res.setHeader('RateLimit-Limit', String(limit));
    ctx.res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    ctx.res.setHeader('RateLimit-Reset', String(reset));
    if (bucket.count > limit) {
      ctx.res.setHeader('Retry-After', String(reset));
      throw new HttpError(429, 'Too many requests, please slow down', { code: 'IBU416' });
    }
    return next();
  };
}

// One line per request: method, path (without the query string, which may hold tokens), status, time, id.
export function logger(options: { log?: (line: string) => void } = {}): Middleware {
  const log = options.log ?? (line => console.log(line));
  return async (ctx, next) => {
    const start = performance.now();
    // Logged when the response is done, so errors handled later still show their real status.
    ctx.res.once('close', () => {
      log(`${ctx.req.method} ${ctx.url.pathname} ${ctx.res.statusCode} ${Math.round(performance.now() - start)}ms ${ctx.requestId}${ctx.res.writableFinished ? '' : ' (aborted)'}`);
    });
    await next();
  };
}
