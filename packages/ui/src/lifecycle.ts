export type Cleanup=()=>void;
const cleanups=new Set<Cleanup>();
export function onCleanup(fn:Cleanup){cleanups.add(fn);return ()=>cleanups.delete(fn);}
export function disposeEffects(){for(const fn of [...cleanups]){cleanups.delete(fn);fn();}}
export function effect(fn:()=>void,dependencies:Array<{subscribe:(cb:()=>void)=>Cleanup}>):Cleanup {fn();const subs=dependencies.map(d=>d.subscribe(fn));return onCleanup(()=>subs.forEach(x=>x()));}
