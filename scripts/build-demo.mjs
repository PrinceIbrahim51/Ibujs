// Builds demo/index.html: one self-contained file (no server, works from file://) that runs
// the real @ibujs/ui engine. Usage: npm run demo
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const result = await build({
  entryPoints: [fileURLToPath(new URL('demo/src/demo.tsx', root))],
  bundle: true,
  write: false,
  minify: true,
  format: 'iife',
  target: ['es2022'],
  jsx: 'automatic',
  jsxImportSource: '@ibujs/ui',
  define: { 'process.env.NODE_ENV': '"production"' }
});
const css = await readFile(new URL('demo/src/demo.css', root), 'utf8');
// "</script" inside the bundle would end the inline script early.
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="IbuJS live demo: signals, routing and the security playground, running the real engine"><title>IbuJS v0.7 demo</title><style>${css}</style></head><body><div id="app"></div><script>${js}</script></body></html>\n`;
await writeFile(new URL('demo/index.html', root), html);
console.log(`✔ demo/index.html (${(html.length / 1024).toFixed(1)} KB)`);

// The same demo as separate files for serving at /demo/ under the strict Content-Security-Policy
// (which blocks inline scripts and styles). ibu.config.json copies site/ into the build.
await mkdir(new URL('site/demo/', root), { recursive: true });
await writeFile(new URL('site/demo/demo.js', root), result.outputFiles[0].text);
await writeFile(new URL('site/demo/demo.css', root), css);
await writeFile(new URL('site/demo/index.html', root), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="IbuJS live demo"><title>IbuJS v0.7 demo</title><link rel="stylesheet" href="/demo/demo.css"></head><body><div id="app"></div><script src="/demo/demo.js"></script></body></html>\n`);
console.log('✔ site/demo/ (CSP-compliant copy served at /demo/)');
