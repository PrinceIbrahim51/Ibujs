import { IbuError } from './errors.js';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions extends Omit<RequestInit, 'credentials' | 'mode' | 'body'> {
  body?: BodyInit | null;
  // Sent as JSON with the right Content-Type.
  json?: unknown;
  // Abort if the server takes longer than this (default 15s; 120s for api.stream).
  timeoutMs?: number;
}

function sameOriginUrl(path: string): URL {
  if (typeof location === 'undefined') {
    throw new IbuError('IBU303', 'api() runs in the browser and calls your own server.', 'On the server, call your functions or database directly instead of over HTTP.');
  }
  // Resolve exactly like fetch() would, then compare origins: catches //evil.com, /\evil.com,
  // https://evil.com and every other spelling of "somewhere else".
  const url = new URL(path, location.href);
  if (url.origin !== location.origin) {
    throw new IbuError('IBU304', `api() only calls your own server; "${path}" points to ${url.origin}.`, 'Call third-party APIs from your server (where keys stay secret) and expose a route like /api/weather.');
  }
  return url;
}

async function request(path: string, options: ApiOptions, accept: string): Promise<Response> {
  const url = sameOriginUrl(path);
  const { json, timeoutMs = 15_000, signal, headers, ...init } = options;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
  const finalHeaders = new Headers(headers);
  if (!finalHeaders.has('Accept')) finalHeaders.set('Accept', accept);
  if (json !== undefined) finalHeaders.set('Content-Type', 'application/json');
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      body: json !== undefined ? JSON.stringify(json) : init.body,
      headers: finalHeaders,
      signal: combined,
      // Fixed: cookies only ever go to your own origin, and redirects elsewhere are refused.
      credentials: 'same-origin',
      mode: 'same-origin'
    });
  } catch (err) {
    if (timeout.aborted) throw new ApiError(0, `Request to ${url.pathname} timed out after ${timeoutMs}ms`);
    throw err;
  }
  if (!response.ok) {
    let data: unknown;
    try { data = await response.json(); } catch { /* not JSON */ }
    const serverMessage = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string' ? (data as { error: string }).error : '';
    throw new ApiError(response.status, serverMessage || `Request to ${url.pathname} failed (${response.status})`, data);
  }
  return response;
}

// `await api('/api/notes')` → parsed JSON. Errors throw ApiError with the server's message.
export async function api<T = unknown>(path: string, options: ApiOptions = {}): Promise<T> {
  const response = await request(path, options, 'application/json');
  if (response.status === 204) return undefined as T;
  const type = response.headers.get('Content-Type') ?? '';
  return (type.includes('json') ? response.json() : response.text()) as Promise<T>;
}

api.get = <T = unknown>(path: string, options: ApiOptions = {}) => api<T>(path, { ...options, method: 'GET' });
api.post = <T = unknown>(path: string, json?: unknown, options: ApiOptions = {}) => api<T>(path, { ...options, method: 'POST', json });
api.put = <T = unknown>(path: string, json?: unknown, options: ApiOptions = {}) => api<T>(path, { ...options, method: 'PUT', json });
api.patch = <T = unknown>(path: string, json?: unknown, options: ApiOptions = {}) => api<T>(path, { ...options, method: 'PATCH', json });
api.delete = <T = unknown>(path: string, options: ApiOptions = {}) => api<T>(path, { ...options, method: 'DELETE' });

// Streams a text response chunk by chunk (used for AI answers):
// for await (const chunk of api.stream('/api/ask', { prompt })) answer.value += chunk;
api.stream = async function* (path: string, json?: unknown, options: ApiOptions = {}): AsyncGenerator<string> {
  const response = await request(path, { timeoutMs: 120_000, ...options, method: options.method ?? 'POST', json }, 'text/plain');
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text) yield text;
    }
    const tail = decoder.decode();
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
};
