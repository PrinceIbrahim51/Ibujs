import http from 'node:http';
import { URL } from 'node:url';
import { randomUUID, timingSafeEqual, scryptSync, randomBytes, createHmac } from 'node:crypto';
function requestIds() { return (ctx, next) => { const id = randomUUID(); ctx.res.setHeader('X-Request-ID', id); ctx.requestId = id; return next(); }; }
function rateLimit(options = {}) {
    const windowMs = options.windowMs ?? 60_000, limit = options.limit ?? 60;
    const buckets = new Map();
    return (ctx, next) => {
        const now = Date.now();
        if (buckets.size > 10000)
            for (const [k, v] of buckets)
                if (v.until <= now)
                    buckets.delete(k);
        const ip = ctx.req.socket.remoteAddress ?? 'unknown';
        let b = buckets.get(ip);
        if (!b || b.until <= now) {
            b = { count: 0, until: now + windowMs };
            buckets.set(ip, b);
        }
        b.count++;
        ctx.res.setHeader('RateLimit-Limit', String(limit));
        ctx.res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - b.count)));
        if (b.count > limit) {
            ctx.res.setHeader('Retry-After', String(Math.ceil((b.until - now) / 1000)));
            ctx.json({ error: 'Too many requests' }, 429);
            return;
        }
        return next();
    };
}
function validateObject(value, schema) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Object.assign(new Error('Expected object'), { status: 400 });
    const input = value;
    const result = {};
    for (const [key, type] of Object.entries(schema)) {
        if (typeof input[key] !== type)
            throw Object.assign(new Error('Invalid field: ' + key), { status: 400 });
        result[key] = input[key];
    }
    return result;
}
function hashPassword(password) { if (password.length < 12)
    throw new Error('Password must have at least 12 characters'); const salt = randomBytes(16); const hash = scryptSync(password, salt, 64); return salt.toString('hex') + ':' + hash.toString('hex'); }
function verifyPassword(password, stored) { try {
    const [s, h] = stored.split(':');
    const hash = Buffer.from(h, 'hex');
    return hash.length === 64 && timingSafeEqual(scryptSync(password, Buffer.from(s, 'hex'), 64), hash);
}
catch {
    return false;
} }
function createSessionManager(secret, ttlSeconds = 3600) {
    if (Buffer.byteLength(secret) < 32)
        throw new Error('Session secret must be at least 32 bytes');
    const sign = (data) => createHmac('sha256', secret).update(data).digest('base64url');
    return { issue(sub) { const payload = Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + ttlSeconds, nonce: randomBytes(12).toString('hex') })).toString('base64url'); return payload + '.' + sign(payload); },
        verify(token) { try {
            const [payload, signature, ...rest] = token.split('.');
            if (rest.length || !payload || !signature)
                return null;
            const a = Buffer.from(signature, 'base64url'), b = Buffer.from(sign(payload), 'base64url');
            if (a.length !== b.length || !timingSafeEqual(a, b))
                return null;
            const obj = JSON.parse(Buffer.from(payload, 'base64url').toString());
            if (typeof obj.sub !== 'string' || typeof obj.exp !== 'number' || obj.exp <= Date.now() / 1000)
                return null;
            return { sub: obj.sub, exp: obj.exp };
        }
        catch {
            return null;
        } } };
}
function sessionCookie(token, secure = true) { return `ibu_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${secure ? '; Secure' : ''}`; }
function createDatabase(adapter) { return { query: (sql, params = []) => adapter.query(sql, params), close: () => adapter.close() }; }
// Bring your own driver; use parameterized queries. No network/database dependency is bundled.
function memoryDatabase(initial = []) { const records = [...initial]; return { all: () => records.map(x => ({ ...x })), insert: (row) => { records.push({ ...row }); return records.length; }, clear: () => { records.length = 0; } }; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function renderDocument(title, body) { return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`; }
export function createServer(options = {}) {
    const routes = new Map();
    const patterns = [];
    const middleware = [];
    const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
    const route = (method, path, handler) => {
        if (!path.startsWith('/'))
            throw new Error('Route must begin with /');
        routes.set(`${method} ${path}`, handler);
        if (path.includes(':'))
            patterns.push({ method, path, handler });
    };
    const handler = async (req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        res.setHeader('Cache-Control', 'no-store');
        const url = new URL(req.url ?? '/', 'http://localhost');
        const ctx = {
            req, res, url, params: {},
            json(data, status = 200) { if (res.writableEnded)
                return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); },
            async body() {
                const contentType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
                if (contentType !== 'application/json')
                    throw Object.assign(new Error('Expected application/json'), { status: 415 });
                let size = 0;
                const chunks = [];
                for await (const chunk of req) {
                    const buf = Buffer.from(chunk);
                    size += buf.length;
                    if (size > maxBodyBytes)
                        throw Object.assign(new Error('Request body too large'), { status: 413 });
                    chunks.push(buf);
                }
                try {
                    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
                }
                catch {
                    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
                }
            }
        };
        let matched = routes.get(`${req.method} ${url.pathname}`);
        if (!matched)
            for (const r of patterns) {
                if (r.method !== req.method)
                    continue;
                const a = r.path.split('/').filter(Boolean), b = url.pathname.split('/').filter(Boolean);
                if (a.length !== b.length)
                    continue;
                const params = {};
                let ok = true;
                for (let i = 0; i < a.length; i++) {
                    if (a[i].startsWith(':')) {
                        try {
                            params[a[i].slice(1)] = decodeURIComponent(b[i]);
                        }
                        catch {
                            ok = false;
                            break;
                        }
                    }
                    else if (a[i] !== b[i]) {
                        ok = false;
                        break;
                    }
                }
                if (ok) {
                    ctx.params = params;
                    matched = r.handler;
                    break;
                }
            }
        const endpoint = matched ?? ((c) => c.json({ error: 'Not found' }, 404));
        try {
            let index = -1;
            const dispatch = async (i) => {
                if (i <= index)
                    throw new Error('next() called multiple times');
                index = i;
                if (i === middleware.length) {
                    await endpoint(ctx);
                    return;
                }
                await middleware[i](ctx, () => dispatch(i + 1));
            };
            await dispatch(0);
            if (!res.writableEnded)
                ctx.json({ error: 'Handler did not send a response' }, 500);
        }
        catch (err) {
            if (res.writableEnded)
                return;
            const status = typeof err === 'object' && err !== null && 'status' in err && [400, 401, 403, 413, 415, 422, 429].includes(Number(err.status)) ? Number(err.status) : 500;
            ctx.json({ error: status === 500 ? 'Internal server error' : err.message }, status);
        }
    };
    return {
        get: (path, fn) => route('GET', path, fn),
        post: (path, fn) => route('POST', path, fn),
        put: (path, fn) => route('PUT', path, fn),
        delete: (path, fn) => route('DELETE', path, fn),
        use: (fn) => { middleware.push(fn); },
        listen: (port = 3000, host = '127.0.0.1') => http.createServer(handler).listen(port, host),
        handler
    };
}
export { requestIds, rateLimit, validateObject, hashPassword, verifyPassword, createSessionManager, memoryDatabase, escapeHtml };
