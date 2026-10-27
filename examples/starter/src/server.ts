import { createServer, requestIds, rateLimit, validateObject, memoryDatabase } from '@ibujs/server';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const app = createServer();
app.use(requestIds());
app.use(rateLimit({limit:120}));
const notes = memoryDatabase();
app.get('/api/notes', ctx => ctx.json({items:notes.all()}));
app.post('/api/notes',async ctx => { const body=validateObject(await ctx.body(),{text:'string'});if((body.text as string).length>200)return ctx.json({error:'Note too long'},400);notes.insert({text:body.text,createdAt:new Date().toISOString()});ctx.json({ok:true},201); });
app.get('/api/users/:id',ctx=>ctx.json({id:ctx.params.id}));
app.get('/api/hello', ctx => ctx.json({ message: 'Hello from IbuJS backend!' }));
app.post('/api/echo', async ctx => {
  const body = await ctx.body<{ message?: unknown }>();
  if (!body || typeof body.message !== 'string' || body.message.length > 200) return ctx.json({ error: 'message must be a string (max 200 chars)' }, 400);
  ctx.json({ message: body.message });
});
// Serve only the starter HTML and built assets, never arbitrary project files.
const projectRoot = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const dist = resolve(projectRoot, 'dist');
app.use(async (ctx, next) => {
  if (ctx.url.pathname.startsWith('/api/')) return next();
  if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') return ctx.json({ error: 'Method not allowed' }, 405);
  const files: Record<string, {path:string; type:string}> = {
    '/': {path:resolve(projectRoot,'examples/starter/index.html'),type:'text/html; charset=utf-8'},
    '/app.js': {path:resolve(dist,'app.js'),type:'text/javascript; charset=utf-8'},
    '/app.css': {path:resolve(dist,'app.css'),type:'text/css; charset=utf-8'}
  };
  const file = files[ctx.url.pathname] ?? (ctx.url.pathname === '/about' || /^\/hello\/[^/]+$/.test(ctx.url.pathname) ? files['/'] : undefined);
  if (!file) return next();
  try {
    await stat(file.path);
    const content = await readFile(file.path);
    ctx.res.writeHead(200, {'Content-Type':file.type, 'Content-Length':content.length,
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : content);
  } catch { ctx.json({ error:'Asset not built; run npm run build or npm run dev' }, 404); }
});
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const host = process.env.HOST ?? '127.0.0.1';
app.listen(port, host);
console.log(`IbuJS ready at http://${host}:${port}`);
