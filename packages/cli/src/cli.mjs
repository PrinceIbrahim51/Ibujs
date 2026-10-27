#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate, review, explainWithAI, CliError } from './ai.mjs';
import { build, dev, start, loadConfig, ConfigError } from './build.mjs';
import { formatFindings, scanProject } from './check.mjs';
import { create, newSecret } from './create.mjs';

const catalog = JSON.parse(readFileSync(new URL('./errors.json', import.meta.url), 'utf8'));
const root = process.cwd();
const [command = 'help', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter(a => a.startsWith('--')));
const args = rest.filter(a => !a.startsWith('--'));
const option = (name, fallback) => { const hit = rest.find(a => a.startsWith(`--${name}=`)); return hit ? hit.split('=').slice(1).join('=') : fallback; };

// Loads .env so AI commands find ANTHROPIC_API_KEY. Values already in the environment win.
if (existsSync(join(root, '.env')) && typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(join(root, '.env')); } catch { /* malformed .env: ignore */ }
}

const HELP = `IbuJS CLI

  ibu create <name>        Create a new app (--npm: use published packages, --vendor: copy the framework in)
  ibu dev                  Start the dev server with reload
  ibu build                Production build into dist/ (--target=vercel: also .vercel/output for Vercel)
  ibu start                Run the production build
  ibu check [paths]        Offline security check (--json for machine output)
  ibu ai "<what to do>"    Ask Claude to change your code, then typecheck + security-check it and let
                           Claude fix what fails (--dry-run, --yes, --branch[=name], --test, --fix-rounds=N,
                           --no-verify, --effort=low|medium|high|xhigh|max)
  ibu review [files]       AI security and bug review of your code
  ibu explain <code|text>  Explain an error (--ai for a tailored answer, --list for all codes)
  ibu secret               Print a strong random secret for SESSION_SECRET
  ibu doctor               Check your setup and suggest fixes

AI commands use ANTHROPIC_API_KEY from .env and model claude-opus-5-5.`;

function explainOffline(input) {
  const codes = [...new Set((input.toUpperCase().match(/IBU\d{3}/g) ?? []))];
  const entries = codes.filter(c => catalog[c]).map(c => ({ code: c, ...catalog[c] }));
  for (const e of entries) {
    console.log(`\n${e.code}: ${e.title}\n\nWhy: ${e.why}\n\nFix: ${e.fix}${e.example ? `\n\nExample:\n  ${e.example}` : ''}`);
  }
  return entries;
}

async function doctor() {
  const config = await loadConfig(root);
  const results = [];
  const add = (ok, text, fix) => results.push({ ok, text, fix });
  const [major, minor] = process.versions.node.split('.').map(Number);
  add(major > 22 || (major === 22 && minor >= 13) ? true : 'warn', `Node.js ${process.versions.node}`, 'Install Node.js 22.13+ (LTS) for the built-in SQLite database.');
  add(existsSync(join(root, 'node_modules')), 'Dependencies installed', 'Run npm install.');
  for (const key of ['client', 'server', 'html']) add(existsSync(join(root, config[key])), `${key} entry ${config[key]}`, 'Fix the path in ibu.config.json.');
  const gitignore = existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf8') : '';
  add(/^\/?\.env$/m.test(gitignore), '.env is git-ignored', 'Add .env to .gitignore.');
  const serverSource = existsSync(join(root, config.server)) ? readFileSync(join(root, config.server), 'utf8') : '';
  if (serverSource.includes('SESSION_SECRET')) {
    const secret = process.env.SESSION_SECRET ?? '';
    add(Buffer.byteLength(secret) >= 32, 'SESSION_SECRET is set and long enough', 'Run `npx ibu secret` and put the value in .env as SESSION_SECRET.');
  }
  add(process.env.ANTHROPIC_API_KEY ? true : 'warn', 'ANTHROPIC_API_KEY set (only needed for AI features)', 'Add it to .env to use `ibu ai` and AI routes.');
  const scan = await scanProject(root, [...new Set([config.client, config.server].map(p => p.split('/').slice(0, -1).join('/') || '.'))]);
  const errors = scan.findings.filter(f => f.severity === 'error').length;
  add(errors ? false : scan.findings.length ? 'warn' : true, `Security check: ${errors} errors, ${scan.findings.length - errors} warnings`, 'Run `npx ibu check` for details.');
  add(existsSync(join(root, config.outDir, 'server.mjs')) ? true : 'warn', 'Production build present', 'Run `npm run build` before `npm start`.');
  for (const r of results) console.log(`${r.ok === true ? '✔' : r.ok === 'warn' ? '!' : '✖'} ${r.text}${r.ok === true ? '' : `\n    → ${r.fix}`}`);
  if (results.some(r => r.ok === false)) process.exitCode = 1;
}

async function main() {
  switch (command) {
    case 'create': return create(args[0], root, { mode: flags.has('--npm') ? 'npm' : flags.has('--vendor') ? 'vendor' : undefined });
    case 'dev': return dev(root);
    case 'build': return build(root, { target: option('target') });
    case 'start': return start(root);
    case 'secret': console.log(newSecret()); return;
    case 'doctor': return doctor();
    case 'check': {
      const config = await loadConfig(root);
      const targets = args.length ? args : [...new Set([config.client, config.server].map(p => p.split('/').slice(0, -1).join('/') || '.'))];
      const result = await scanProject(root, targets);
      console.log(flags.has('--json') ? JSON.stringify(result, null, 2) : formatFindings(result, catalog));
      if (result.findings.some(f => f.severity === 'error')) process.exitCode = 1;
      return;
    }
    case 'explain': {
      if (flags.has('--list')) { for (const [code, e] of Object.entries(catalog)) console.log(`${code}  ${e.title}`); return; }
      const text = args.join(' ');
      if (!text) throw new CliError('Usage: npx ibu explain IBU412   or   npx ibu explain "paste the error message" --ai');
      const entries = explainOffline(text);
      if (flags.has('--ai')) return explainWithAI({ root, text, entries, file: option('file') });
      if (!entries.length) console.log('No IbuJS error code found in that text. Add --ai for an AI explanation, or run `npx ibu explain --list`.');
      return;
    }
    case 'ai': {
      const config = await loadConfig(root);
      const rounds = Number(option('fix-rounds', '2'));
      return generate({
        root, config, task: args.join(' '),
        yes: flags.has('--yes'), dryRun: flags.has('--dry-run'), force: flags.has('--force'), effort: option('effort', 'high'),
        fixRounds: Number.isInteger(rounds) && rounds >= 0 && rounds <= 5 ? rounds : 2,
        verify: !flags.has('--no-verify'), runTests: flags.has('--test'), branch: option('branch') ?? flags.has('--branch')
      });
    }
    case 'review': {
      const config = await loadConfig(root);
      return review({ root, config, paths: args, effort: option('effort', 'high') });
    }
    default: console.log(HELP);
  }
}

main().catch(err => {
  if (err instanceof CliError || err instanceof ConfigError) console.error(err.message);
  else console.error(err);
  process.exitCode = 1;
});
