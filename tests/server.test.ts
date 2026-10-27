import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../packages/server/src/index.js';
test('GET routing, 404 and security headers', async () => {
 const app = createServer(); app.get('/hello', ctx => ctx.json({ ok:true }));
 const server = app.listen(0); await once(server,'listening');
 try { const address=server.address(); if (!address || typeof address==='string') throw Error('No address');
  const base=`http://127.0.0.1:${address.port}`;
  const res=await fetch(base+'/hello'); assert.deepEqual(await res.json(),{ok:true}); assert.equal(res.headers.get('x-content-type-options'),'nosniff');
  const missing=await fetch(base+'/missing'); assert.equal(missing.status,404);
 } finally { server.close(); await once(server,'close'); }
});
test('middleware and JSON body validation', async () => {
 const app=createServer({maxBodyBytes:32}); let called=false;
 app.use(async (_ctx,next)=>{called=true; await next();});
 app.post('/echo',async ctx=>ctx.json(await ctx.body()));
 const server=app.listen(0); await once(server,'listening');
 try {const address=server.address(); if(!address||typeof address==='string') throw Error('No address'); const url=`http://127.0.0.1:${address.port}/echo`;
 const ok=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"a":1}'}); assert.deepEqual(await ok.json(),{a:1}); assert.equal(called,true);
 const bad=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'not json'}); assert.equal(bad.status,400);
 const large=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({x:'a'.repeat(100)})}); assert.equal(large.status,413);
 } finally {server.close();await once(server,'close');}
});
