import { IbuError } from '@ibumomujs/ui';

export interface CookieOptions {
  maxAge?: number;
  expires?: Date;
  path?: string;
  domain?: string;
  // Defaults: secure when the request is HTTPS, httpOnly true, sameSite 'Lax', path '/'.
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function parseCookies(header: string | undefined): Record<string, string> {
  // Null prototype: a cookie named "__proto__" or "constructor" is just a key.
  const cookies: Record<string, string> = Object.create(null);
  if (!header) return cookies;
  let count = 0;
  for (const part of header.split(';')) {
    if (++count > 100) break;
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!TOKEN.test(name) || name in cookies) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try { cookies[name] = decodeURIComponent(value); } catch { cookies[name] = value; }
  }
  return cookies;
}

export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  if (!TOKEN.test(name)) throw new IbuError('IBU505', `"${name}" is not a valid cookie name.`, 'Use letters, digits, "-" and "_".');
  const { path = '/', httpOnly = true, sameSite = 'Lax', secure = false } = options;
  if (sameSite === 'None' && !secure) throw new IbuError('IBU505', `Cookie "${name}" uses SameSite=None without Secure; browsers reject it.`, 'SameSite=None requires HTTPS (secure: true).');
  if (name.startsWith('__Host-') && (!secure || path !== '/' || options.domain)) {
    throw new IbuError('IBU505', `Cookie "${name}" needs secure: true, path "/" and no domain because of its __Host- prefix.`);
  }
  let out = `${name}=${encodeURIComponent(value)}; Path=${path}; SameSite=${sameSite}`;
  if (options.maxAge !== undefined) out += `; Max-Age=${Math.max(0, Math.floor(options.maxAge))}`;
  if (options.expires) out += `; Expires=${options.expires.toUTCString()}`;
  if (options.domain) out += `; Domain=${options.domain}`;
  if (httpOnly) out += '; HttpOnly';
  if (secure) out += '; Secure';
  return out;
}
