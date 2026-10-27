import { build as esbuild, context } from 'esbuild';
import { spawn } from 'node:child_process';
import { existsSync, watch } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);

export class ConfigError extends Error {}

export async function loadConfig(root) {
  const file = join(root, 'ibu.config.json');
  const user = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : {};
  const config = { client: 'src/main.tsx', server: 'src/server.ts', html: 'index.html', publicDir: 'public', outDir: 'dist', external: [], ...user };
  return config;
}

function requireEntry(root, config, key) {
  const path = resolve(root, config[key]);
  if (!existsSync(path)) throw new ConfigError(`[IBU901] ${key} entry "${config[key]}" was not found. Check ibu.config.json.`);
  return path;
}

// Fails the browser build if it pulls in server-only code, which would leak secrets into the page.
const serverOnlyGuard = {
  name: 'ibu-server-only-guard',
  setup(build) {
    build.onResolve({ filter: /^(?:@ibujs\/(?:server|ai)|@anthropic-ai\/sdk|node:.*|fs|child_process|crypto)$/ }, args => ({
      errors: [{ text: `[IBU702] Browser code imports "${args.path}", which is server-only and could expose secrets. Move this code to your server and call it through an API route.` }]
    }));
  }
};

function clientOptions(root, config, production) {
  return {
    entryPoints: [requireEntry(root, config, 'client')],
    bundle: true,
    outfile: join(root, config.outDir, 'public', 'app.js'),
    platform: 'browser',
    format: 'esm',
    target: ['es2022'],
    jsx: 'automatic',
    jsxImportSource: '@ibujs/ui',
    minify: production,
    sourcemap: !production,
    define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
    plugins: [serverOnlyGuard],
    logLevel: 'warning'
  };
}

async function copyStatic(root, config) {
  const outPublic = join(root, config.outDir, 'public');
  await mkdir(outPublic, { recursive: true });
  const html = await readFile(requireEntry(root, config, 'html'), 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) console.warn('[IbuJS] index.html has an inline <script>; the default Content-Security-Policy blocks it. Move the code into src/.');
  await writeFile(join(outPublic, 'index.html'), html);
  const assets = join(root, config.publicDir);
  if (existsSync(assets)) await cp(assets, outPublic, { recursive: true });
}

export async function build(root) {
  const config = await loadConfig(root);
  const out = join(root, config.outDir);
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'public'), { recursive: true });
  await Promise.all([
    esbuild(clientOptions(root, config, true)),
    esbuild({
      entryPoints: [requireEntry(root, config, 'server')],
      bundle: true,
      outfile: join(out, 'server.mjs'),
      platform: 'node',
      format: 'esm',
      target: 'node22',
      jsx: 'automatic',
      jsxImportSource: '@ibujs/ui',
      external: config.external,
      sourcemap: true,
      // Lets bundled CommonJS dependencies use require() inside the ES module output.
      banner: { js: "import { createRequire as __ibuCreateRequire } from 'node:module'; const require = __ibuCreateRequire(import.meta.url);" },
      logLevel: 'warning'
    }),
    copyStatic(root, config)
  ]);
  console.log(`✔ Built ${config.outDir}/public (browser) and ${config.outDir}/server.mjs (server). Run: npm start`);
}

function run(file, args, env) {
  const child = spawn(process.execPath, [...args, file], { stdio: 'inherit', env: { ...process.env, ...env } });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return child;
}

export async function dev(root) {
  const config = await loadConfig(root);
  const outPublic = join(root, config.outDir, 'public');
  await mkdir(outPublic, { recursive: true });
  await copyStatic(root, config);
  const ctx = await context(clientOptions(root, config, false));
  await ctx.rebuild();
  await ctx.watch();
  watch(resolve(root, config.html), () => { copyStatic(root, config).catch(err => console.error(err.message)); });
  const tsx = require.resolve('tsx/cli');
  const server = requireEntry(root, config, 'server');
  console.log('Watching for changes. Edit src/ and the page or server reloads.');
  const child = spawn(process.execPath, [tsx, 'watch', '--clear-screen=false', server], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development', IBU_PUBLIC_DIR: outPublic }
  });
  const shutdown = async () => { child.kill('SIGTERM'); await ctx.dispose(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

export async function start(root) {
  const config = await loadConfig(root);
  const server = join(root, config.outDir, 'server.mjs');
  if (!existsSync(server)) throw new ConfigError('[IBU902] Nothing is built yet. Run `npm run build` first.');
  const child = run(server, ['--enable-source-maps'], { NODE_ENV: 'production', IBU_PUBLIC_DIR: join(root, config.outDir, 'public') });
  child.on('exit', code => process.exit(code ?? 1));
}
