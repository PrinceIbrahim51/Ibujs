// Real-browser security regression suite: every payload here executed in v0.5 or is a known
// XSS vector. Each one must render without running attacker code.
// Run: npm run test:e2e (needs Playwright + Chromium: `npm i --no-save playwright && npx playwright install chromium`).
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); }
catch { console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium'); process.exit(1); }

const entry = fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url));
const bundle = (await build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'Ibu', platform: 'browser' })).outputFiles[0].text;

// A blank page over real HTTP, with no CSP on purpose: the renderer itself must be safe even
// on pages that lack one.
const server = createServer((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>e2e</title>'));
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const context = await browser.newContext();
const executed = [];
// Payloads call report(); the binding exists in every frame and survives navigations
// (including javascript: URLs), so any execution is recorded.
await context.exposeFunction('report', name => { executed.push(name); });

// [name, expression, click links/buttons afterwards]
const payloads = [
  ['control: real onClick handler (must run)', `h('button', { onClick: () => report('canary') }, 'ok')`, true],
  ['a href javascript:', `h('a', { href: 'javascript:report("href")' }, 'x')`, true],
  ['a href with tab', `h('a', { href: 'java\\tscript:report("tab")' }, 'x')`, true],
  ['a href with newline', `h('a', { href: 'java\\nscript:report("newline")' }, 'x')`, true],
  ['a href leading \\x01', `h('a', { href: '\\x01javascript:report("ctrl")' }, 'x')`, true],
  ['a href mixed case + spaces', `h('a', { href: '  JaVaScRiPt:report("case")' }, 'x')`, true],
  ['a href vbscript:', `h('a', { href: 'vbscript:msgbox(1)' }, 'x')`, true],
  ['a href data:text/html', `h('a', { href: 'data:text/html,<script>report("data")</script>' }, 'x')`, true],
  ['form action javascript:', `h('form', { action: 'javascript:report("action")' }, h('button', {}, 'go'))`, true],
  ['button formaction', `h('form', {}, h('button', { formaction: 'javascript:report("formaction")' }, 'go'))`, true],
  ['iframe src javascript:', `h('iframe', { src: 'javascript:report("iframe")' })`, false],
  ['iframe srcdoc', `h('iframe', { srcdoc: '<script>report("srcdoc")</script>' })`, false],
  ['object data javascript:', `h('object', { data: 'javascript:report("object")' })`, false],
  ['embed src javascript:', `h('embed', { src: 'javascript:report("embed")' })`, false],
  ['svg a xlink:href', `h('svg', {}, h('a', { 'xlink:href': 'javascript:report("xlink")' }, h('text', { y: 10 }, 'x')))`, true],
  ['svg animate href', `h('svg', {}, h('a', {}, h('animate', { attributeName: 'href', values: 'javascript:report("animate")' }), h('text', { y: 10 }, 'x')))`, true],
  ['script element', `h('script', {}, 'report("script")')`, false],
  ['base element', `h('base', { href: 'https://evil.example/' })`, false],
  ['JSON object as child (script)', `h('p', {}, JSON.parse('{"type":"script","props":{"children":["report(\\\\"json\\\\")"]}}'))`, false],
  ['JSON object as child (img)', `h('p', {}, JSON.parse('{"type":"img","props":{"src":"x","onerror":"report(\\\\"json-img\\\\")"}}'))`, false],
  ['onclick string attribute', `h('button', { onclick: 'report("onclick")' }, 'x')`, true],
  ['onClick string attribute', `h('button', { onClick: 'report("onClick")' }, 'x')`, true],
  ['innerHTML prop', `h('div', { innerHTML: '<img src=x onerror=report("innerHTML")>' })`, false],
  ['dangerouslySetInnerHTML', `h('div', { dangerouslySetInnerHTML: { __html: '<img src=x onerror=report("dsih")>' } })`, false],
  ['meta http-equiv refresh', `h('meta', { 'http-equiv': 'refresh', content: '0;url=javascript:report("meta")' })`, false],
  ['text that looks like HTML', `h('p', {}, '<img src=x onerror=report("text")>')`, false]
];

const results = [];
for (const [name, expr, click] of payloads) {
  const page = await context.newPage();
  await page.goto(origin);
  await page.addScriptTag({ content: bundle });
  const outcome = await page.evaluate(([expr]) => {
    const { h, createApp, onSecurityViolation } = Ibu;
    const violations = [];
    const errors = [];
    onSecurityViolation(v => violations.push(v.code));
    const root = document.createElement('div');
    document.body.append(root);
    createApp(() => (0, eval)(`(h) => ${expr}`)(h), root, { onError: e => errors.push(String(e.message).split('\n')[0]) });
    if (errors.length) return 'refused ' + errors[0];
    if (violations.length) return 'neutralised ' + [...new Set(violations)].join(',');
    return 'rendered as text/safe markup';
  }, [expr]);
  if (click) {
    for (const el of await page.$$('a, button')) await el.click({ timeout: 1000, noWaitAfter: true }).catch(() => {});
  }
  await page.waitForTimeout(250);
  await page.close();
  results.push({ name, outcome });
}

// Behaviour regressions found in v0.5.
const page = await context.newPage();
await page.goto(origin);
await page.addScriptTag({ content: bundle });
const behaviour = await page.evaluate(async () => {
  const { h, createApp, signal, nextTick } = Ibu;
  const out = {};
  const root = document.createElement('div'); document.body.append(root);
  const entry = signal('');
  createApp(() => h('input', { id: 'inp', bind: entry }), root);
  const inp = document.getElementById('inp');
  inp.value = 'hello'; inp.dispatchEvent(new Event('input'));
  out.bindUpdatesSignal = entry.value === 'hello';
  entry.value = ''; await nextTick();
  out.inputClearsWhenSignalResets = inp.value === '';
  const svgRoot = document.createElement('div'); document.body.append(svgRoot);
  createApp(() => h('svg', { id: 'svg1' }, h('circle', { r: 5 })), svgRoot);
  out.svgUsesSvgNamespace = document.getElementById('svg1').namespaceURI === 'http://www.w3.org/2000/svg' && svgRoot.querySelector('circle').namespaceURI === 'http://www.w3.org/2000/svg';
  const items = signal([1, 2, 3]);
  const listRoot = document.createElement('ul'); document.body.append(listRoot);
  createApp(() => items.value.map(i => h('li', { key: i }, String(i))), listRoot);
  const first = listRoot.firstChild;
  items.value = [3, 2, 1]; await nextTick();
  out.keyedReorderKeepsDomNodes = listRoot.lastChild === first && listRoot.textContent === '321';
  out.apiRejectsBackslashOrigin = await Ibu.api('/\\evil.example/x').then(() => false, e => /IBU304/.test(e.message));
  return out;
});
await browser.close();
server.close();

console.table(results.map(r => ({ payload: r.name, result: r.outcome.slice(0, 80) })));
console.log('behaviour checks:', behaviour);
const failures = [];
const attacks = executed.filter(x => x !== 'canary');
if (!executed.includes('canary')) failures.push('control payload did not run, so the harness cannot detect execution');
if (attacks.length) failures.push(`attacker code ran: ${attacks.join(', ')}`);
for (const [check, ok] of Object.entries(behaviour)) if (!ok) failures.push(`behaviour check failed: ${check}`);
if (failures.length) { console.error('\nFAIL\n- ' + failures.join('\n- ')); process.exit(1); }
console.log(`\nPASS: ${payloads.length - 1} XSS payloads, none executed (control handler did run); ${Object.keys(behaviour).length} behaviour checks passed.`);
