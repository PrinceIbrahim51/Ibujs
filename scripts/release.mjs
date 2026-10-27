// Builds publishable packages into .release/: compiled JavaScript + type declarations, a
// package.json with npm metadata, README and LICENSE. Workspace development keeps using the
// TypeScript sources directly; only the published copies are compiled.
//   node scripts/release.mjs            # build and pack into .release/*.tgz
//   node scripts/release.mjs --verify   # also create an app from the packed tarballs and run it
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = join(root, '.release');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const repository = 'https://github.com/PrinceIbrahim51/Ibujs';
const PACKAGES = ['ui', 'server', 'ai', 'cli', 'create-ibujs'];
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sh = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'pipe', encoding: 'utf8' });

const READMES = {
  ui: 'Browser runtime: signals, JSX, a secure-by-default renderer with per-component updates and hydration, router, api().',
  server: 'Server: routing, typed validation, CSRF/CORS, sessions, scrypt passwords, authorization policies, SQL tag + SQLite, static files, SSR.',
  ai: 'Server-only Claude helpers (ask, stream, route) with rate, size, concurrency and disconnect guards.',
  cli: 'The `ibu` command: create, dev, build (also --target=vercel), start, check, ai, review, explain, secret, doctor.',
  'create-ibujs': 'Create a new IbuJS app.'
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const name of PACKAGES) {
  const manifest = JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error(`packages/${name} is ${manifest.version}, expected ${version} (root package.json). Bump all versions together.`);
}

console.log('Compiling TypeScript packages…');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
sh(process.execPath, [tsc, '-p', join(root, 'tsconfig.release.json')]);

const rewriteExports = exports => Object.fromEntries(Object.entries(exports).map(([key, target]) => {
  if (typeof target !== 'string' || !target.endsWith('.ts')) return [key, target];
  const base = target.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '');
  return [key, { types: `${base}.d.ts`, default: `${base}.js` }];
}));
const pinWorkspaceDeps = deps => deps && Object.fromEntries(Object.entries(deps).map(([dep, range]) =>
  [dep, dep.startsWith('@ibujs/') ? `^${version}` : range]));

for (const name of PACKAGES) {
  const source = join(root, 'packages', name);
  const target = join(out, name);
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  mkdirSync(target, { recursive: true });
  const files = ['README.md', 'LICENSE'];
  if (existsSync(join(out, 'build', name))) {
    cpSync(join(out, 'build', name, 'src'), join(target, 'dist'), { recursive: true });
    files.push('dist');
  } else {
    // Plain-JavaScript packages ship as they are.
    for (const entry of readdirSync(source)) {
      if (entry === 'package.json' || entry === 'node_modules') continue;
      cpSync(join(source, entry), join(target, entry), { recursive: true });
      files.push(entry);
    }
  }
  if (name === 'cli') { cpSync(join(root, 'llms.txt'), join(target, 'llms.txt')); files.push('llms.txt'); }
  cpSync(join(root, 'LICENSE'), join(target, 'LICENSE'));
  writeFileSync(join(target, 'README.md'), `# ${manifest.name}\n\n${READMES[name]}\n\nPart of [IbuJS](${repository}), the secure-by-default, AI-native full-stack TypeScript framework.\n\n\`\`\`bash\nnpm create ibujs@latest my-app\n\`\`\`\n\nDocs: ${repository}#readme · Security: ${repository}/blob/HEAD/SECURITY.md\n`);
  const published = {
    ...manifest,
    ...(manifest.exports ? { exports: rewriteExports(manifest.exports) } : {}),
    dependencies: pinWorkspaceDeps(manifest.dependencies),
    files: [...new Set(files)],
    repository: { type: 'git', url: `git+${repository}.git`, directory: `packages/${name}` },
    homepage: `${repository}#readme`,
    bugs: `${repository}/issues`,
    keywords: ['ibujs', 'framework', 'typescript', 'jsx', 'signals', 'secure', 'ai'],
    engines: { node: '>=22.13' },
    publishConfig: { access: 'public', provenance: true }
  };
  writeFileSync(join(target, 'package.json'), JSON.stringify(published, null, 2) + '\n');
  sh(npm, ['pack', '--silent', '--pack-destination', out], target);
}
rmSync(join(out, 'build'), { recursive: true, force: true });
const tarballs = readdirSync(out).filter(f => f.endsWith('.tgz'));
console.log(`✔ Packed ${tarballs.length} packages into .release/: ${tarballs.join(', ')}`);

if (process.argv.includes('--verify')) {
  // Proves the published artifacts work on their own: create an app with the packed CLI in npm
  // mode, install every @ibujs package from the tarballs, then typecheck, check, build and run it.
  const dir = mkdtempSync(join(tmpdir(), 'ibu-release-'));
  try {
    sh(process.execPath, [join(out, 'cli', 'src', 'cli.mjs'), 'create', 'release-check', '--npm'], dir);
    const app = join(dir, 'release-check');
    const tgz = name => join(out, tarballs.find(t => t.startsWith(name.replace('@', '').replace('/', '-') + '-')));
    const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
    const local = Object.fromEntries(['@ibujs/ui', '@ibujs/server', '@ibujs/ai', '@ibujs/cli'].map(n => [n, `file:${tgz(n)}`]));
    for (const n of ['@ibujs/ui', '@ibujs/server', '@ibujs/ai']) pkg.dependencies[n] = local[n];
    pkg.devDependencies['@ibujs/cli'] = local['@ibujs/cli'];
    pkg.overrides = local;
    writeFileSync(join(app, 'package.json'), JSON.stringify(pkg, null, 2));
    console.log('Installing the packed packages into a fresh app…');
    sh(npm, ['install', '--no-audit', '--no-fund', '--silent'], app);
    const bin = join(app, 'node_modules', '.bin');
    sh(join(bin, 'tsc'), ['--noEmit'], app);
    sh(join(bin, 'ibu'), ['check'], app);
    sh(join(bin, 'ibu'), ['build'], app);
    const port = 3900 + Math.floor(Math.random() * 90);
    const server = spawn(process.execPath, [join(app, 'dist', 'server.mjs')], { cwd: app, env: { ...process.env, PORT: String(port), IBU_PUBLIC_DIR: join(app, 'dist', 'public'), DATABASE_FILE: ':memory:' }, stdio: 'ignore' });
    try {
      let page = '';
      for (let i = 0; i < 40 && !page; i++) {
        await new Promise(r => setTimeout(r, 250));
        page = await fetch(`http://127.0.0.1:${port}/`).then(r => r.ok ? r.text() : '', () => '');
      }
      if (!page.includes('/app.js')) throw new Error('The built app did not serve its page.');
      const note = await fetch(`http://127.0.0.1:${port}/api/notes`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"release check"}' });
      if (note.status !== 201) throw new Error(`POST /api/notes returned ${note.status}`);
    } finally { server.kill(); }
    console.log('✔ Verified: a new app built from the packed packages typechecks, passes ibu check, builds and serves requests.');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
