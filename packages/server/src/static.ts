import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageCspOf, type Middleware } from './app.js';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.pdf': 'application/pdf', '.webmanifest': 'application/manifest+json'
};

// Where `ibu build` puts the browser bundle. `ibu dev`/`ibu start` set IBU_PUBLIC_DIR for you.
export function publicDir(): string {
  return process.env.IBU_PUBLIC_DIR ?? resolve(process.cwd(), 'dist/public');
}

export interface StaticOptions {
  // Serve index.html for unknown paths that look like pages (for client-side routing).
  spa?: boolean;
  // Cache lifetime for files; HTML is always revalidated.
  maxAgeSeconds?: number;
}

// Serves files from `root` only: no "..", no dotfiles (.env, .git), no symlinks that point outside.
export function serveStatic(root: string | URL = publicDir(), options: StaticOptions = {}): Middleware {
  const base = resolve(root instanceof URL ? fileURLToPath(root) : root);
  let realBase: string | undefined;
  const locate = async (segments: string[]): Promise<string | undefined> => {
    let file = resolve(base, ...segments);
    if (file !== base && !file.startsWith(base + sep)) return;
    try {
      let info = await stat(file);
      if (info.isDirectory()) { file = resolve(file, 'index.html'); info = await stat(file); }
      if (!info.isFile()) return;
      realBase ??= await realpath(base);
      const real = await realpath(file);
      if (real !== realBase && !real.startsWith(realBase + sep)) return;
      return real;
    } catch { return; }
  };
  return async (ctx, next) => {
    if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') return next();
    let decoded: string;
    try { decoded = decodeURIComponent(ctx.url.pathname); } catch { return next(); }
    if (decoded.includes('\0') || decoded.includes('\\')) return next();
    const segments = decoded.split('/').filter(Boolean);
    if (segments.some(part => part.startsWith('.'))) return next();
    let file = await locate(segments);
    const accept = String(ctx.req.headers.accept ?? '');
    if (!file && options.spa && !extname(decoded) && accept.includes('text/html')) file = await locate(['index.html']);
    if (!file) return next();
    const info = await stat(file);
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
    const isHtml = type.startsWith('text/html');
    ctx.res.setHeader('ETag', etag);
    ctx.res.setHeader('Last-Modified', info.mtime.toUTCString());
    ctx.res.setHeader('Cache-Control', isHtml || !options.maxAgeSeconds ? 'no-cache' : `public, max-age=${options.maxAgeSeconds}`);
    if (isHtml) ctx.res.setHeader('Content-Security-Policy', pageCspOf(ctx));
    if (type === 'application/octet-stream') ctx.res.setHeader('Content-Disposition', 'attachment');
    if (ctx.req.headers['if-none-match'] === etag) { ctx.res.writeHead(304); ctx.res.end(); return; }
    ctx.res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size });
    if (ctx.req.method === 'HEAD') { ctx.res.end(); return; }
    await new Promise<void>((done, fail) => {
      createReadStream(file!).on('error', fail).pipe(ctx.res).on('finish', done).on('error', fail);
    });
  };
}
