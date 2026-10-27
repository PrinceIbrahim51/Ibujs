import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from '../packages/server/src/index.js';

type App = ReturnType<typeof createServer>;

// Starts the app on a random port, runs fn with its base URL, and always shuts it down.
export async function withServer(app: App, fn: (base: string) => Promise<void>) {
  const server = app.listen(0);
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); server.close(); }
}

// Low-level request for things fetch() normalises away (odd request targets, raw headers, big uploads).
export function rawRequest(base: string, options: http.RequestOptions & { body?: string | Buffer; chunks?: Buffer[] }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, ...options }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; }).on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.chunks) {
      const write = (i: number) => {
        if (i >= options.chunks!.length) { req.end(); return; }
        if (!req.write(options.chunks![i])) req.once('drain', () => write(i + 1)); else setImmediate(() => write(i + 1));
      };
      req.on('error', () => {});
      write(0);
    } else req.end(options.body);
  });
}

export const json = (data: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
