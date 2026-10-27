import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
export interface Session {sub:string;exp:number}
export function createSessionManager(secret:string,ttlSeconds=3600){if(Buffer.byteLength(secret)<32)throw new Error('Session secret must be at least 32 bytes');
 const sign=(data:string)=>createHmac('sha256',secret).update(data).digest('base64url');
 return {issue(sub:string){const payload=Buffer.from(JSON.stringify({sub,exp:Math.floor(Date.now()/1000)+ttlSeconds,nonce:randomBytes(12).toString('hex')})).toString('base64url');return payload+'.'+sign(payload);},
 verify(token:string):Session|null{try{const [payload,signature,...rest]=token.split('.');if(rest.length||!payload||!signature)return null;const a=Buffer.from(signature,'base64url'),b=Buffer.from(sign(payload),'base64url');if(a.length!==b.length||!timingSafeEqual(a,b))return null;const obj=JSON.parse(Buffer.from(payload,'base64url').toString());if(typeof obj.sub!=='string'||typeof obj.exp!=='number'||obj.exp<=Date.now()/1000)return null;return {sub:obj.sub,exp:obj.exp};}catch{return null;}}};}
export function sessionCookie(token:string,secure=true){return `ibu_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600${secure?'; Secure':''}`;}
