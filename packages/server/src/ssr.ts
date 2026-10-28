import { html, isSafeHtml, isSafeUrl, renderToString, IbuError, type Child, type SafeHtml } from '@ibumomujs/ui';
export { html, escapeHtml, renderToString, isSafeHtml, SafeHtml } from '@ibumomujs/ui';

export interface PageOptions {
  title: string;
  // JSX, or HTML from html`` / renderToString(). Plain strings are shown as text, never as HTML.
  body?: Child | SafeHtml;
  lang?: string;
  description?: string;
  scripts?: string[];
  styles?: string[];
}

function checkAsset(url: string) {
  if (!isSafeUrl(url, 'script', 'src')) throw new IbuError('IBU101', `renderPage(): refusing asset URL ${JSON.stringify(url)}.`, 'Use paths like "/app.js".');
  return url;
}

// A complete HTML document that works with the strict default Content-Security-Policy
// (no inline scripts or styles). Use with ctx.html(renderPage({...})).
export function renderPage(options: PageOptions): SafeHtml {
  const { title, body, lang = 'en', description, scripts = [], styles = [] } = options;
  const content = body === undefined ? '' : isSafeHtml(body) ? body : typeof body === 'string' ? body : renderToString(body as Child);
  return html`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${description ? html`<meta name="description" content="${description}">` : ''}${styles.map(href => html`<link rel="stylesheet" href="${checkAsset(href)}">`)}</head><body><div id="app">${content}</div>${scripts.map(src => html`<script type="module" src="${checkAsset(src)}"></script>`)}</body></html>`;
}

// v0.5 helper. `body` is now escaped unless it is SafeHtml (from html`` or renderToString), which
// closes the XSS hole of passing raw strings.
export function renderDocument(title: string, body: string | SafeHtml): SafeHtml {
  return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body>${body}</body></html>`;
}
