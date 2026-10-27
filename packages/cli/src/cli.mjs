#!/usr/bin/env node
import { build, context } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
const command = process.argv[2] ?? 'help';
const root = process.cwd();
const out = resolve(root, 'dist');
const browser = { entryPoints: [resolve(root, 'examples/starter/src/main.tsx')], bundle: true, outfile: resolve(out, 'app.js'), platform: 'browser', format: 'esm', jsx: 'automatic', jsxImportSource: '@ibujs/ui', sourcemap: command === 'dev', minify: command === 'build' };
const backend = { entryPoints: [resolve(root, 'examples/starter/src/server.ts')], bundle: true, packages: 'external', outfile: resolve(out, 'server.mjs'), platform: 'node', format: 'esm' };
async function run() {
  if (command === 'create') {
    const name = process.argv[3];
    if (!name || !/^[a-z][a-z0-9-]{1,48}$/.test(name)) throw new Error('Usage: ibu create my-app (lowercase letters, numbers, hyphens)');
    const destination = resolve(root, name);
    if (destination === root) throw new Error('Invalid destination');
    const { existsSync } = await import('node:fs');
    if (existsSync(destination)) throw new Error('Destination already exists: ' + destination);
    // Ship a self-contained workspace with local framework packages, starter and tests.
    await mkdir(destination, { recursive: true });
    for (const item of ['packages', 'examples', 'tests', '.github', 'tsconfig.json', '.npmrc', '.gitignore', '.env.example', 'LICENSE']) {
      const source = resolve(root, item);
      if (existsSync(source)) await cp(source, resolve(destination, item), { recursive: true });
    }
    const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    manifest.name = name;
    await writeFile(resolve(destination, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(resolve(destination, 'README.md'), `# ${name}\n\nCreated with IbuJS v0.5.\n\nRun: \`npm install\`, then \`npm run dev\`.\n`);
    console.log(`Created ${name}. Run: cd ${name} && npm install && npm run dev`);
  } else if (command === 'build') {
    await mkdir(out, { recursive: true });
    await Promise.all([build(browser), build(backend)]);
    console.log('Built dist/app.js and dist/server.mjs');
  } else if (command === 'dev') {
    await mkdir(out, { recursive: true });
    const ctx = await context(browser);
    await ctx.watch();
    console.log('Watching browser bundle. Open http://127.0.0.1:3000');
    const child = spawn(process.execPath, ['--import', 'tsx', 'examples/starter/src/server.ts'], { stdio: 'inherit', cwd: root });
    const shutdown = async () => { child.kill(); await ctx.dispose(); process.exit(0); };
    process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
  } else if (command === 'start') {
    const child = spawn(process.execPath, [resolve(out, 'server.mjs')], { stdio: 'inherit', cwd: root });
    child.on('exit', code => process.exit(code ?? 1));
  } else {
    console.log('IbuJS CLI: ibu create my-app | ibu dev | ibu build | ibu start');
  }
}
run().catch(err => { console.error(err); process.exitCode = 1; });
