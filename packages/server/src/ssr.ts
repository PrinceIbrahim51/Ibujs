export function escapeHtml(value:unknown):string{return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
export function renderDocument(title:string,body:string){return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;}
// Pass trusted, escaped HTML fragments to renderDocument; never pass untrusted raw HTML.
