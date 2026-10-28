import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { IbuError } from '@ibumomujs/ui';
import { HttpError, type Context, type Middleware } from './app.js';

const scrypt = (password: string | Buffer, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCallback(password, salt, keylen, options, (err, key) => err ? reject(err) : resolve(key)));

// OWASP-recommended scrypt cost (N=2^15, r=8, p=3: ~32 MiB, tens of ms). Runs off the main
// thread, so logins never freeze the server.
const PARAMS = { N: 2 ** 15, r: 8, p: 3 };
const KEYLEN = 64;
const MIN_LENGTH = 12;
const MAX_BYTES = 1024;

function scryptOptions(N: number, r: number, p: number): ScryptOptions {
  return { N, r, p, maxmem: 128 * N * r * 2 };
}

export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || [...password].length < MIN_LENGTH) {
    throw new HttpError(400, `Password must be at least ${MIN_LENGTH} characters`, { code: 'IBU502' });
  }
  if (Buffer.byteLength(password) > MAX_BYTES) throw new HttpError(400, 'Password is too long', { code: 'IBU502' });
  const salt = randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEYLEN, scryptOptions(PARAMS.N, PARAMS.r, PARAMS.p));
  return `$scrypt$n=${PARAMS.N},r=${PARAMS.r},p=${PARAMS.p}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function parseHash(stored: string): { N: number; r: number; p: number; salt: Buffer; hash: Buffer; legacy: boolean } | null {
  const modern = /^\$scrypt\$n=(\d+),r=(\d+),p=(\d+)\$([\w-]+)\$([\w-]+)$/.exec(stored);
  if (modern) {
    const [N, r, p] = [Number(modern[1]), Number(modern[2]), Number(modern[3])];
    // Bounds stop a corrupted or malicious stored hash from requesting gigabytes of memory.
    if (N < 2 ** 10 || N > 2 ** 20 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
    return { N, r, p, salt: Buffer.from(modern[4], 'base64url'), hash: Buffer.from(modern[5], 'base64url'), legacy: false };
  }
  // v0.5 format: hex salt ":" hex hash, Node's default scrypt parameters.
  const legacy = /^([0-9a-f]{32}):([0-9a-f]{128})$/.exec(stored);
  if (legacy) return { N: 16384, r: 8, p: 1, salt: Buffer.from(legacy[1], 'hex'), hash: Buffer.from(legacy[2], 'hex'), legacy: true };
  return null;
}

let dummyHash: Promise<string> | undefined;

// Pass the stored hash, or null/undefined when the user does not exist: the same amount of work
// is done either way, so response times do not reveal which emails have accounts.
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (typeof password !== 'string' || Buffer.byteLength(password) > MAX_BYTES) return false;
  const parsed = typeof stored === 'string' ? parseHash(stored) : null;
  if (!parsed) {
    dummyHash ??= hashPassword('ibujs-timing-equaliser');
    const fake = parseHash(await dummyHash)!;
    await scrypt(password, fake.salt, KEYLEN, scryptOptions(fake.N, fake.r, fake.p));
    return false;
  }
  const input = parsed.legacy ? password : password.normalize('NFKC');
  const candidate = await scrypt(input, parsed.salt, parsed.hash.length, scryptOptions(parsed.N, parsed.r, parsed.p));
  return candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
}

// True for v0.5 hashes or weaker parameters: re-hash and store after a successful login.
export function needsRehash(stored: string): boolean {
  const parsed = parseHash(stored);
  return !parsed || parsed.legacy || parsed.N < PARAMS.N || parsed.r < PARAMS.r || parsed.p < PARAMS.p;
}

export interface Session { sub: string; iat: number; exp: number; jti: string; data?: Record<string, string | number | boolean> }
export interface SessionOptions {
  // The first secret signs new sessions; all of them verify, so you can rotate keys without logging everyone out.
  secret: string | string[];
  ttlSeconds?: number;
  cookieName?: string;
  // Return true to reject a session (e.g. after logout-everywhere or a password change).
  isRevoked?: (session: Session) => boolean | Promise<boolean>;
}

const TOKEN_PREFIX = 'v1';
const MAX_TOKEN_LENGTH = 4096;

function checkSecret(secret: string) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) {
    throw new IbuError('IBU501', 'The session secret must be at least 32 bytes long.', 'Generate one with `npx ibu secret`, put it in .env as SESSION_SECRET, and read it with process.env.SESSION_SECRET.');
  }
  if (new Set(secret).size < 10 || /change.?me|replace.?me|your.?secret|^x+$/i.test(secret)) {
    throw new IbuError('IBU501', 'The session secret looks like a placeholder or has too little variety to be secure.', 'Generate a random one with `npx ibu secret`.');
  }
}

export function createSessionManager(secretOrOptions: string | SessionOptions, ttlSeconds = 3600) {
  const options: SessionOptions = typeof secretOrOptions === 'string' ? { secret: secretOrOptions, ttlSeconds } : secretOrOptions;
  const secrets = Array.isArray(options.secret) ? options.secret : [options.secret];
  if (!secrets.length) checkSecret('');
  secrets.forEach(checkSecret);
  const ttl = options.ttlSeconds ?? ttlSeconds;
  const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(`ibujs-session.${TOKEN_PREFIX}.${payload}`).digest();

  const issue = (sub: string, data?: Session['data']): string => {
    if (typeof sub !== 'string' || !sub) throw new IbuError('IBU504', 'sessions.issue() needs the user id as a non-empty string.');
    const now = Math.floor(Date.now() / 1000);
    const session: Session = { sub, iat: now, exp: now + ttl, jti: randomBytes(16).toString('base64url'), ...(data ? { data } : {}) };
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    return `${TOKEN_PREFIX}.${payload}.${sign(secrets[0], payload).toString('base64url')}`;
  };

  const verify = (token: unknown): Session | null => {
    try {
      if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null;
      const [version, payload, signature, ...rest] = token.split('.');
      if (version !== TOKEN_PREFIX || rest.length || !payload || !signature) return null;
      const given = Buffer.from(signature, 'base64url');
      // Reject non-canonical encodings so each session has exactly one valid token string.
      if (given.length !== 32 || given.toString('base64url') !== signature) return null;
      if (!secrets.some(secret => timingSafeEqual(given, sign(secret, payload)))) return null;
      const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      const now = Date.now() / 1000;
      if (typeof obj.sub !== 'string' || typeof obj.exp !== 'number' || typeof obj.iat !== 'number' || typeof obj.jti !== 'string') return null;
      if (obj.exp <= now || obj.iat > now + 60) return null;
      return { sub: obj.sub, iat: obj.iat, exp: obj.exp, jti: obj.jti, ...(obj.data && typeof obj.data === 'object' ? { data: obj.data } : {}) };
    } catch { return null; }
  };

  const cookieFor = (ctx: Context) => options.cookieName ?? (ctx.secure ? '__Host-ibu_session' : 'ibu_session');
  const read = async (ctx: Context): Promise<Session | null> => {
    if ('session' in ctx.state) return ctx.state.session as Session | null;
    let session = verify(ctx.cookies.get(cookieFor(ctx)));
    if (session && options.isRevoked && await options.isRevoked(session)) session = null;
    ctx.state.session = session;
    return session;
  };

  return {
    issue,
    verify,
    // Starts a session: sets an HttpOnly, SameSite=Lax cookie (Secure + __Host- prefix over HTTPS).
    login(ctx: Context, userId: string, data?: Session['data']) {
      const token = issue(userId, data);
      ctx.cookies.set(cookieFor(ctx), token, { maxAge: ttl, secure: ctx.secure, httpOnly: true, sameSite: 'Lax', path: '/' });
      ctx.state.session = verify(token);
      return token;
    },
    logout(ctx: Context) {
      ctx.cookies.delete(cookieFor(ctx), { secure: ctx.secure, path: '/' });
      ctx.state.session = null;
    },
    // The current session or null.
    get: read,
    // The current session, or a 401 error if nobody is logged in.
    async require(ctx: Context): Promise<Session> {
      const session = await read(ctx);
      if (!session) throw new HttpError(401, 'Please log in first', { code: 'IBU503' });
      return session;
    },
    // Middleware form: app.use(sessions.middleware()) puts the session on ctx.state.session.
    middleware(): Middleware {
      return async (ctx, next) => { await read(ctx); await next(); };
    }
  };
}

// v0.5 helper, kept for compatibility. Prefer sessions.login(ctx, userId).
export function sessionCookie(token: string, secure = true, maxAgeSeconds = 3600) {
  return `ibu_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}
