export async function api<T>(path:string,options:RequestInit={}):Promise<T>{
 if(!path.startsWith('/')||path.startsWith('//'))throw new Error('Only same-origin API paths allowed');
 const response=await fetch(path,{credentials:'same-origin',...options,headers:{Accept:'application/json',...options.headers}});
 if(!response.ok)throw new Error(`API request failed (${response.status})`);
 return response.json() as Promise<T>;
}
