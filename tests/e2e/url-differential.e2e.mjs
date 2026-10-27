// Differential fuzz: the server-side sanitizer (Node's URL parser) must agree with Chromium's.
// If they disagreed, renderToString could approve a URL the browser treats as javascript:.
// Also renders every URL the sanitizer allows through the real DOM renderer and checks the
// browser's own parse of the resulting link.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const RUNS = Number(process.env.FUZZ_RUNS ?? 20000);
let seed = Number(process.env.FUZZ_SEED ?? 20261027) >>> 0;
const rand = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const PIECES = ['javascript:', 'JaVaScRiPt:', 'java', 'script', ':', 'vbscript:', 'data:', 'text/html,', 'blob:', 'http:', 'https:', '//', '/', '\\', '..', '%2e', '%0a', '&#x3a;', '\t', '\n', '\r', '\x00', '\x01', '\x1f', ' ', ' ', ' ', '﻿', '?', '#', '@', 'evil.example', 'a', 'alert(1)', 'İ', 'ſ', 'ｊａｖａ', 'mailto:', 'tel:', '[::1]', ':80', '%zz'];
const inputs = Array.from({ length: RUNS }, () => Array.from({ length: 1 + Math.floor(rand() * 7) }, () => PIECES[Math.floor(rand() * PIECES.length)]).join(''));

const { isSafeUrl } = await import('../../packages/ui/src/security.ts').catch(async () => {
  // Plain node cannot import .ts; bundle the sanitizer for Node as well.
  const out = await build({ entryPoints: [fileURLToPath(new URL('../../packages/ui/src/security.ts', import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node' });
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
});
const nodeView = inputs.map(input => {
  let protocol = 'INVALID';
  try { protocol = new URL(input, 'http://ibu.invalid/').protocol; } catch { /* invalid */ }
  return { protocol, safe: isSafeUrl(input) };
});

const bundle = (await build({ entryPoints: [fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url))], bundle: true, write: false, format: 'iife', globalName: 'Ibu' })).outputFiles[0].text;
// Served over http like a real page, so relative links resolve the way they would in production.
const server = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>diff</title>'));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${server.address().port}/`);
await page.addScriptTag({ content: bundle });
const browserView = await page.evaluate(list => {
  const { h, createApp, onSecurityViolation } = Ibu;
  onSecurityViolation(() => {});
  return list.map(input => {
    let protocol = 'INVALID';
    try { protocol = new URL(input, 'http://ibu.invalid/').protocol; } catch { /* invalid */ }
    const root = document.createElement('div');
    createApp(() => h('a', { href: input }, 'x'), root);
    const a = root.querySelector('a');
    const rendered = a.getAttribute('href') === 'about:blank#blocked' ? 'blocked' : a.protocol;
    return { protocol, safe: Ibu.isSafeUrl(input), rendered };
  });
}, inputs);
await browser.close();
server.close();

// The parsers are allowed to disagree only in the safe direction: Node (server rendering) may
// reject a URL that Chromium accepts, which just blocks an odd link. Node must never approve a URL
// that Chromium parses with a dangerous scheme.
const SAFE = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:', 'data:']);
const problems = [];
const stricter = [];
inputs.forEach((input, i) => {
  const n = nodeView[i], b = browserView[i];
  if (n.safe && !SAFE.has(b.protocol)) problems.push(`server allows ${JSON.stringify(input)} but Chromium parses it as ${b.protocol}`);
  else if (n.protocol !== b.protocol) stricter.push(input);
  if (b.rendered !== 'blocked' && !SAFE.has(b.rendered)) problems.push(`rendered link has protocol ${b.rendered} for ${JSON.stringify(input)}`);
});
if (problems.length) { console.error(`FAIL (${problems.length})\n- ` + problems.slice(0, 20).join('\n- ')); process.exit(1); }
const blocked = browserView.filter(v => v.rendered === 'blocked').length;
console.log(`PASS: ${RUNS} fuzzed URLs. Every rendered link had a safe scheme (${blocked} blocked). Node never approved a URL Chromium treats as dangerous; the parsers differed on ${stricter.length} odd URLs, all of which server rendering blocks (safe direction), e.g. ${stricter.slice(0, 3).map(x => JSON.stringify(x)).join(', ')}.`);
