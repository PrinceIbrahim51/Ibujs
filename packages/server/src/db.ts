export interface DatabaseAdapter {query<T=unknown>(sql:string,params?:readonly unknown[]):Promise<T[]>;close():Promise<void>}
export function createDatabase(adapter:DatabaseAdapter){return {query:<T=unknown>(sql:string,params:readonly unknown[]=[])=>adapter.query<T>(sql,params),close:()=>adapter.close()};}
// Bring your own driver; use parameterized queries. No network/database dependency is bundled.
export function memoryDatabase(initial:Record<string,unknown>[]=[]){const records=[...initial];return {all:()=>records.map(x=>({...x})),insert:(row:Record<string,unknown>)=>{records.push({...row});return records.length;},clear:()=>{records.length=0;}};}
