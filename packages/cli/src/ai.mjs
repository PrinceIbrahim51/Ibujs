// AI commands for the CLI: `ibu ai "<task>"`, `ibu review [files]`, `ibu explain <error> --ai`.
// Every change the AI proposes is path-checked and security-linted before anything is written,
// and nothing is written without your confirmation (or --yes).
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { scanProject, scanSource } from './check.mjs';

export const MODEL = 'claude-opus-5-5';
const here = dirname(fileURLToPath(import.meta.url));
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.html', '.json', '.md', '.svg', '.txt']);
const PROTECTED_FILES = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const PROTECTED_DIRS = new Set(['node_modules', 'packages', 'dist', '.git', '.github']);
const MAX_CONTEXT_BYTES = 200_000;
const MAX_FILE_BYTES = 200_000;

const say = (...args) => console.log(...args);
const dim = text => process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[2m${text}\x1b[0m` : text;

export class CliError extends Error {}

async function loadClient() {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_PROFILE && !existsSync(join(process.env.HOME ?? '', '.config/anthropic'))) {
    throw new CliError('No Anthropic API key found (IBU802).\n  1. Create a key at https://platform.claude.com\n  2. Add ANTHROPIC_API_KEY=... to your .env file (it is git-ignored)\n  3. Run the command again.\n  The key stays on your machine; never put it in code.');
  }
  let Anthropic;
  try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')); }
  catch { throw new CliError('The Anthropic SDK is not installed. Run: npm install'); }
  return { client: new Anthropic(), Anthropic };
}

// Turns SDK errors into one actionable sentence (most specific first).
function explainApiError(err, Anthropic) {
  if (err instanceof Anthropic.AuthenticationError) return 'Your Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Your API key cannot use this model. Check your Anthropic account and plan.';
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic is rate limiting your key. Wait a minute and try again.';
  if (err instanceof Anthropic.BadRequestError) return 'The request was rejected: ' + err.message;
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your internet connection or proxy.';
  if (err instanceof Anthropic.APIError) return `The Anthropic API returned an error (${err.status ?? 'unknown'}): ${err.message}`;
  return null;
}

// Assistant turns are sent back exactly as received (append-only), except that after a mid-answer
// safety fallback the declined attempt's thinking and tool blocks are dropped, as the API requires.
export function echoContent(content) {
  const lastFallback = content.map(block => block.type).lastIndexOf('fallback');
  if (lastFallback < 0) return content;
  return content.filter((block, i) => i > lastFallback || !['thinking', 'redacted_thinking', 'tool_use', 'server_tool_use'].includes(block.type));
}

async function callClaude({ system, user, messages, effort, maxTokens, schema, onText }) {
  const { client, Anthropic } = await loadClient();
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: maxTokens,
      // The framework reference in `system` is identical between runs, so it is cached (cheaper, faster).
      cache_control: { type: 'ephemeral' },
      system,
      messages: messages ?? [{ role: 'user', content: user }],
      output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
      // If a safety classifier declines, Anthropic retries on its recommended fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default'
    });
    if (onText) stream.on('text', onText);
    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') throw new CliError('The AI declined this request. Try rephrasing it.');
    if (message.stop_reason === 'max_tokens') throw new CliError('The answer was too long and got cut off. Ask for a smaller change.');
    const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('');
    return messages ? { text, content: message.content } : text;
  } catch (err) {
    if (err instanceof CliError) throw err;
    const friendly = explainApiError(err, Anthropic);
    if (friendly) throw new CliError(friendly);
    throw err;
  }
}

async function readIfExists(path) {
  try { return await readFile(path, 'utf8'); } catch { return ''; }
}

// The framework reference (llms.txt) and project rules (AGENTS.md) the AI must follow.
async function frameworkGuide(root) {
  const reference = await readIfExists(join(root, 'llms.txt')) || await readIfExists(join(here, '../../../llms.txt'));
  const rules = await readIfExists(join(root, 'AGENTS.md')) || await readIfExists(join(here, '../template/AGENTS.md'));
  return `<ibujs_reference>\n${reference}\n</ibujs_reference>\n\n<project_rules>\n${rules}\n</project_rules>`;
}

async function listFiles(dir, root, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || PROTECTED_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, root, out);
    else if (TEXT_EXTENSIONS.has(extname(entry.name))) out.push(relative(root, full).split(sep).join('/'));
  }
  return out;
}

async function projectFiles(root, config, only) {
  const candidates = only?.length ? only : [
    ...await listFiles(resolve(root, dirname(config.client)), root),
    ...await listFiles(resolve(root, dirname(config.server)), root),
    config.html, 'ibu.config.json'
  ];
  let budget = MAX_CONTEXT_BYTES;
  const files = [];
  const skipped = [];
  for (const path of [...new Set(candidates)]) {
    const full = resolve(root, path);
    if (!full.startsWith(root + sep) || !existsSync(full)) continue;
    const text = await readFile(full, 'utf8');
    if (Buffer.byteLength(text) > budget) { skipped.push(path); continue; }
    budget -= Buffer.byteLength(text);
    files.push({ path, text });
  }
  return { files, skipped };
}

const fileBlock = ({ path, text }) => `<file path="${path}">\n${text}\n</file>`;

// Where the AI may write: inside the project, never into secrets, dependencies or the framework.
export function checkTarget(root, path) {
  if (typeof path !== 'string' || !path || path.includes('\0') || isAbsolute(path) || /^[a-zA-Z]:/.test(path) || path.includes('\\')) return 'not a relative path';
  const normal = posix.normalize(path);
  if (normal.startsWith('..') || normal.startsWith('/')) return 'outside the project';
  const parts = normal.split('/');
  if (parts.some(p => p.startsWith('.'))) return 'hidden files (like .env) are off-limits';
  if (parts.some(p => PROTECTED_DIRS.has(p))) return `${parts.find(p => PROTECTED_DIRS.has(p))}/ is off-limits`;
  if (PROTECTED_FILES.has(parts[parts.length - 1])) return 'dependency manifests are off-limits (install packages yourself)';
  if (!TEXT_EXTENSIONS.has(extname(normal))) return `${extname(normal) || 'files without an extension'} not allowed`;
  const full = resolve(root, normal);
  if (!full.startsWith(root + sep)) return 'outside the project';
  return null;
}

const GENERATE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
    notes: { type: 'array', items: { type: 'string' } }
  },
  required: ['summary', 'files', 'notes'],
  additionalProperties: false
};

const GENERATE_SYSTEM = `You are the IbuJS coding assistant working inside a developer's project. Many users are beginners, so write clear, simple, well-structured code.

Make the change the developer asks for and return the complete new contents of every file you create or modify.

Rules:
- Use only the IbuJS APIs in <ibujs_reference> plus Node.js built-ins. Do not add npm dependencies.
- Follow <project_rules>. In particular: validate request bodies with s.object(...); query with db.sql\`...\`; never use innerHTML, eval or string event handlers; keep secrets in process.env and on the server.
- Keep the change focused on the request and preserve existing behaviour and style.
- Paths are relative to the project root and must stay inside it (normally src/ and index.html). Do not edit package.json, dotfiles or packages/.
- Return whole files, not diffs. Only include files that change.
- In "notes", tell a beginner anything they must do by hand (for example add an environment variable or restart the dev server). Keep "summary" to two sentences.`;

function lineChanges(before, after) {
  const count = text => text.split('\n').reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
  const a = count(before), b = count(after);
  let added = 0, removed = 0;
  for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
  for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
  return { added, removed };
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}

function run(command, args, cwd, timeoutMs) {
  return new Promise(done => {
    execFile(command, args, { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      done({ ok: !err, output: `${stdout}${stderr}`.trim() || (err ? String(err.message) : '') });
    });
  });
}

function findTsc(root) {
  for (const from of [join(root, 'package.json'), fileURLToPath(import.meta.url)]) {
    try { return createRequire(from).resolve('typescript/bin/tsc'); } catch { /* try the next location */ }
  }
  return null;
}

// Static checks only by default (nothing generated is executed); --test also runs the test suite.
export async function verifyProject(root, config, { runTests = false } = {}) {
  const failures = [];
  const tsc = existsSync(join(root, 'tsconfig.json')) ? findTsc(root) : null;
  if (tsc) {
    const result = await run(process.execPath, [tsc, '--noEmit', '-p', root], root, 180_000);
    if (!result.ok) failures.push({ check: 'typecheck (tsc --noEmit)', output: result.output });
  }
  const targets = [...new Set([config.client, config.server].map(p => dirname(p)))];
  const lint = await scanProject(root, targets);
  const lintErrors = lint.findings.filter(f => f.severity === 'error');
  if (lintErrors.length) failures.push({ check: 'security check (ibu check)', output: lintErrors.map(f => `${f.file}:${f.line} ${f.rule} ${f.message}: ${f.snippet}`).join('\n') });
  if (runTests) {
    const pkg = JSON.parse(await readIfExists(join(root, 'package.json')) || '{}');
    if (pkg.scripts?.test) {
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      const result = await run(npm, ['test', '--silent'], root, 300_000);
      if (!result.ok) failures.push({ check: 'tests (npm test)', output: result.output });
    }
  }
  return { ok: !failures.length, failures, checked: [tsc ? 'typecheck' : null, 'security check', runTests ? 'tests' : null].filter(Boolean) };
}

function parsePlan(raw) {
  let plan;
  try { plan = JSON.parse(raw); } catch { throw new CliError('The AI response was not valid JSON. Please try again.'); }
  if (!plan || !Array.isArray(plan.files)) throw new CliError('The AI response had an unexpected shape. Please try again.');
  return plan;
}

// Shows a plan, checks every file, and writes it only with consent. Shared by the first change and every fix round.
async function applyPlan(root, plan, { yes, dryRun, force, question }) {
  say(`\n${plan.summary}\n`);
  const accepted = [];
  let blocked = false;
  for (const file of plan.files) {
    const problem = checkTarget(root, file?.path);
    if (problem || typeof file.content !== 'string' || Buffer.byteLength(file.content) > MAX_FILE_BYTES) {
      say(`  ✖ ${file?.path}: rejected (IBU903: ${problem ?? 'content too large'})`);
      blocked = true;
      continue;
    }
    const full = resolve(root, posix.normalize(file.path));
    const before = existsSync(full) ? await readFile(full, 'utf8') : null;
    const { added, removed } = lineChanges(before ?? '', file.content);
    const issues = scanSource(file.content, file.path);
    say(`  ${before === null ? '+ new     ' : '~ modified'} ${file.path}  ${dim(`+${added} -${removed} lines`)}`);
    for (const issue of issues) say(`      ${issue.severity === 'error' ? '✖' : '!'} ${issue.rule} ${issue.message} (line ${issue.line}): ${issue.snippet}`);
    if (issues.some(i => i.severity === 'error')) blocked = true;
    accepted.push({ full, path: posix.normalize(file.path), content: file.content });
  }
  if (plan.notes?.length) say(`\nNotes:\n${plan.notes.map(n => '  • ' + n).join('\n')}`);
  if (dryRun) {
    for (const file of accepted) say(`\n${'─'.repeat(60)}\n${file.path}\n${'─'.repeat(60)}\n${file.content}`);
    say('\nDry run: nothing was written.');
    return { written: [], stop: true };
  }
  if (!accepted.length) { say('\nNothing to write.'); return { written: [], stop: true }; }
  if (blocked && !force) {
    say('\nSome proposed changes failed the security check (✖ above), so nothing was written.\nAsk again with more detail, or re-run with --force after reviewing them yourself (--dry-run shows the code).');
    return { written: [], blocked: true, stop: true };
  }
  if (!yes && !await confirm(question(accepted.length))) {
    say(process.stdin.isTTY ? 'Cancelled. Nothing was written.' : 'Not a terminal, so nothing was written. Re-run with --yes to apply.');
    return { written: [], stop: true };
  }
  for (const file of accepted) {
    await mkdir(dirname(file.full), { recursive: true });
    await writeFile(file.full, file.content);
  }
  say(`✔ Wrote ${accepted.length} file${accepted.length === 1 ? '' : 's'}.`);
  return { written: accepted.map(f => f.path), stop: false };
}

const git = (root, args) => run('git', args, root, 60_000);

async function startBranch(root, task, requested) {
  if (!(await git(root, ['rev-parse', '--is-inside-work-tree'])).ok) { say(dim('Not a git repository, so --branch was skipped.')); return null; }
  const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';
  const name = typeof requested === 'string' && requested ? requested : `ibu-ai/${slug}-${Date.now().toString(36)}`;
  if (!(await git(root, ['check-ref-format', '--branch', name])).ok) throw new CliError(`"${name}" is not a valid branch name.`);
  const created = await git(root, ['switch', '-c', name]);
  if (!created.ok) throw new CliError(`Could not create branch ${name}: ${created.output}`);
  say(dim(`Working on new branch ${name}`));
  return name;
}

export async function generate({ root, config, task, yes = false, dryRun = false, force = false, effort = 'high', fixRounds = 2, verify = true, runTests = false, branch }) {
  if (!task?.trim()) throw new CliError('Describe what you want, e.g.: npx ibu ai "add a page that lists my notes with a delete button"');
  const { files, skipped } = await projectFiles(root, config);
  const system = GENERATE_SYSTEM + '\n\n' + await frameworkGuide(root);
  const messages = [{ role: 'user', content: `<project_files>\n${files.map(fileBlock).join('\n')}\n</project_files>\n\n<task>\n${task}\n</task>` }];
  const branchName = branch && !dryRun ? await startBranch(root, task, branch) : null;
  const written = new Set();
  let verification = null;
  for (let round = 0; ; round++) {
    say(dim(round === 0
      ? `Asking Claude (${MODEL}) with ${files.length} project files${skipped.length ? `, ${skipped.length} too large to include` : ''}…`
      : `Asking Claude to fix the problems (round ${round} of ${fixRounds})…`));
    let received = 0;
    const reply = await callClaude({
      system,
      messages,
      effort,
      maxTokens: 64_000,
      schema: GENERATE_SCHEMA,
      onText: text => { received += text.length; if (process.stdout.isTTY) process.stdout.write(`\r${dim(`  generating… ${received} characters`)}`); }
    });
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
    const plan = parsePlan(reply.text);
    const applied = await applyPlan(root, plan, {
      yes, dryRun, force,
      question: n => round === 0 ? `\nApply ${n} file change${n === 1 ? '' : 's'}? [y/N] ` : `\nApply this fix (${n} file${n === 1 ? '' : 's'})? [y/N] `
    });
    applied.written.forEach(path => written.add(path));
    if (applied.stop) break;
    if (!verify) break;
    say(dim('Checking the result…'));
    verification = await verifyProject(root, config, { runTests });
    if (verification.ok) { say(`✔ ${verification.checked.join(', ')} passed.`); break; }
    say(`\n✖ ${verification.failures.map(f => f.check).join(', ')} failed:`);
    for (const failure of verification.failures) say(`\n${failure.check}:\n${failure.output.split('\n').slice(0, 15).map(l => '  ' + l).join('\n')}`);
    if (round >= fixRounds) { say(`\nStopped after ${fixRounds} fix round${fixRounds === 1 ? '' : 's'}. Fix the remaining problems by hand, or run ibu ai again with more detail.`); break; }
    if (!yes && !await confirm('\nAsk Claude to fix these problems? [y/N] ')) break;
    // Append-only conversation: the previous answer exactly as returned, then what went wrong.
    const current = [];
    for (const path of written) current.push({ path, text: await readFile(resolve(root, path), 'utf8') });
    const report = verification.failures.map(f => `<check name="${f.check}">\n${f.output.slice(0, 12_000)}\n</check>`).join('\n');
    messages.push({ role: 'assistant', content: echoContent(reply.content) });
    messages.push({ role: 'user', content: `Your change was applied, but these checks failed:\n<verification_failures>\n${report}\n</verification_failures>\n\n<current_files>\n${current.map(fileBlock).join('\n')}\n</current_files>\n\nFix the problems your change caused. Return only the files that need to change, complete.` });
  }
  if (branchName && written.size) {
    await git(root, ['add', '--', ...written]);
    const committed = await git(root, ['commit', '-m', `ibu ai: ${task.slice(0, 60)}`, '-m', `Generated with npx ibu ai (${MODEL}).${verification ? ` Checks: ${verification.ok ? 'passed' : 'failing'}.` : ''}`]);
    say(committed.ok ? `✔ Committed to branch ${branchName}. Review with: git diff HEAD~1` : `Could not commit (${committed.output.split('\n')[0]}). The files are written; commit them yourself.`);
  } else if (written.size) {
    say('Review the changes with git diff, then run npm run dev.');
  }
  return { written: [...written], verification };
}

const REVIEW_SYSTEM = `You are a senior application-security reviewer for IbuJS projects. Review the given files for security vulnerabilities first, then correctness bugs that would break the app.

For each real problem: give the file and line, what can go wrong (a concrete scenario), and the exact fix using IbuJS APIs from <ibujs_reference>. Rank by severity. Do not report style preferences or hypothetical issues you cannot tie to the code. If the code is fine, say so briefly. Write for a beginner: short sentences, no jargon without a one-line explanation. Use Markdown.`;

export async function review({ root, config, paths = [], effort = 'high' }) {
  const { files, skipped } = await projectFiles(root, config, paths.length ? paths : undefined);
  if (!files.length) throw new CliError('No files to review. Pass paths, e.g.: npx ibu review src/server.ts');
  const lint = await scanProject(root, files.map(f => f.path));
  say(dim(`Reviewing ${files.length} files with ${MODEL}${skipped.length ? ` (${skipped.length} skipped: too large)` : ''}…\n`));
  await callClaude({
    system: REVIEW_SYSTEM + '\n\n' + await frameworkGuide(root),
    user: `<project_files>\n${files.map(fileBlock).join('\n')}\n</project_files>\n\n<automated_check_findings>\n${JSON.stringify(lint.findings, null, 2)}\n</automated_check_findings>\n\nReview these files.`,
    effort,
    maxTokens: 32_000,
    onText: text => process.stdout.write(text)
  });
  process.stdout.write('\n');
}

export async function explainWithAI({ root, text, entries, file }) {
  const context = file ? `\n\n<file path="${file}">\n${await readFile(resolve(root, file), 'utf8')}\n</file>` : '';
  await callClaude({
    system: 'You explain IbuJS errors to beginners. Using the catalog entries and reference, explain in plain language what went wrong, the most likely cause, and the exact fix (with a short code example). Be brief.\n\n' + await frameworkGuide(root),
    user: `<error>\n${text}\n</error>\n\n<catalog_entries>\n${JSON.stringify(entries, null, 2)}\n</catalog_entries>${context}`,
    effort: 'medium',
    maxTokens: 16_000,
    onText: chunk => process.stdout.write(chunk)
  });
  process.stdout.write('\n');
}
