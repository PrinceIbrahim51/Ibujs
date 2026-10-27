// Rendering benchmark in Chromium: 1,000 keyed rows, each a component reading its own signal.
//   node scripts/bench-render.mjs                     # current engine
//   node scripts/bench-render.mjs --baseline=v0.6.0   # also a git ref, for comparison
// Needs Playwright + Chromium (`npm i --no-save playwright && npx playwright install chromium`).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const repo = fileURLToPath(new URL('..', import.meta.url));
const baseline = process.argv.find(a => a.startsWith('--baseline='))?.split('=')[1];

async function bundle(uiDir) {
  const result = await build({
    stdin: { contents: `export * from ${JSON.stringify(join(uiDir, 'index.ts'))};`, resolveDir: repo, loader: 'ts' },
    bundle: true, write: false, format: 'iife', globalName: 'Ibu', minify: true,
    define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent'
  });
  return result.outputFiles[0].text;
}

const engines = [['current', await bundle(join(repo, 'packages/ui/src'))]];
let temp;
if (baseline) {
  temp = mkdtempSync(join(tmpdir(), 'ibu-bench-'));
  execFileSync('sh', ['-c', `git -C "${repo}" archive "${baseline}" packages/ui/src | tar -x -C "${temp}"`]);
  engines.push([baseline, await bundle(join(temp, 'packages/ui/src'))]);
}

const browser = await chromium.launch();
const results = [];
for (const [name, code] of engines) {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><div id="app"></div>');
  await page.addScriptTag({ content: code });
  const r = await page.evaluate(async () => {
    const { h, createApp, signal, nextTick } = Ibu;
    const median = list => list.sort((a, b) => a - b)[Math.floor(list.length / 2)];
    const rows = signal(Array.from({ length: 1000 }, (_, id) => ({ id, label: signal('row ' + id) })));
    const Row = props => h('li', {}, props.row.label.value);
    let t = performance.now();
    createApp(() => h('ul', {}, rows.value.map(row => h(Row, { key: row.id, row }))), '#app');
    const mount = performance.now() - t;
    const single = [];
    for (let i = 0; i < 30; i++) {
      t = performance.now();
      rows.peek()[500].label.value = 'updated ' + i;
      await new Promise(r => queueMicrotask(r));
      await new Promise(r => queueMicrotask(r));
      single.push(performance.now() - t);
      await nextTick();
    }
    const swap = [];
    for (let i = 0; i < 10; i++) {
      t = performance.now();
      const next = [...rows.peek()];
      [next[1], next[998]] = [next[998], next[1]];
      rows.value = next;
      await new Promise(r => setTimeout(r, 0));
      swap.push(performance.now() - t);
    }
    return { mount, updateOneRow: median(single), swapTwoRows: median(swap), text: document.querySelectorAll('li')[500].textContent };
  });
  results.push({ engine: name, 'mount 1,000 rows (ms)': r.mount.toFixed(1), 'update 1 row (ms)': r.updateOneRow.toFixed(2), 'swap 2 rows (ms)': r.swapTwoRows.toFixed(1), check: r.text });
  await page.close();
}
await browser.close();
if (temp) rmSync(temp, { recursive: true, force: true });
console.table(results);
