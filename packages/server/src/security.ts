import { randomUUID, timingSafeEqual, scryptSync, randomBytes } from 'node:crypto';
import type { Middleware } from './index.js';
export function requestIds(): Middleware { return (ctx,next) => { const id=randomUUID(); ctx.res.setHeader('X-Request-ID',id); ctx.requestId=id; return next(); }; }
export function rateLimit(options:{windowMs?:number;limit?:number}={}): Middleware {
 const windowMs=options.windowMs??60_000, limit=options.limit??60;
 const buckets=new Map<string,{count:number;until:number}>();
 return (ctx,next)=>{const now=Date.now();if(buckets.size>10000)for(const [k,v] of buckets)if(v.until<=now)buckets.delete(k);
 const ip=ctx.req.socket.remoteAddress??'unknown';let b=buckets.get(ip);if(!b||b.until<=now){b={count:0,until:now+windowMs};buckets.set(ip,b);}b.count++;
 ctx.res.setHeader('RateLimit-Limit',String(limit));ctx.res.setHeader('RateLimit-Remaining',String(Math.max(0,limit-b.count)));
 if(b.count>limit){ctx.res.setHeader('Retry-After',String(Math.ceil((b.until-now)/1000)));ctx.json({error:'Too many requests'},429);return;}return next();};
}
export function validateObject(value:unknown, schema:Record<string,'string'|'number'|'boolean'>):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Object.assign(new Error('Expected object'),{status:400});
 const input=value as Record<string,unknown>;const result:Record<string,unknown>={};
 for(const [key,type] of Object.entries(schema)){if(typeof input[key]!==type)throw Object.assign(new Error('Invalid field: '+key),{status:400});result[key]=input[key];}return result;
}
export function hashPassword(password:string):string {if(password.length<12)throw new Error('Password must have at least 12 characters');const salt=randomBytes(16);const hash=scryptSync(password,salt,64);return salt.toString('hex')+':'+hash.toString('hex');}
export function verifyPassword(password:string,stored:string):boolean {try{const [s,h]=stored.split(':');const hash=Buffer.from(h,'hex');return hash.length===64&&timingSafeEqual(scryptSync(password,Buffer.from(s,'hex'),64),hash);}catch{return false;}}
