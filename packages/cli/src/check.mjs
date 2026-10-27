// `ibu check`: an offline security linter tuned for the mistakes beginners (and AI assistants)
// make most often. Each rule maps to an IbuJS error code, so `ibu explain IBU7xx` explains it.
// Silence a finding on purpose with a comment on the same or previous line: // ibu-ignore IBU710
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

const r = (source, flags = '') => new RegExp(source, flags);

// scope: 'client' (browser code), 'server', or 'any'. comments: also scan comment lines.
export const RULES = [
  { id: 'IBU701', severity: 'error', scope: 'any', comments: true, message: 'Hard-coded secret or API key', patterns: [
    /sk-ant-[A-Za-z0-9_-]{20,}/, /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    /\b(?:api[_-]?key|secret|password|passwd|token|auth[_-]?token|private[_-]?key)\w*['"]?\s*[:=]\s*['"`][^'"`\s$]{12,}['"`]/i
  ] },
  { id: 'IBU702', severity: 'error', scope: 'client', message: 'Server secret or server-only module used in browser code', patterns: [
    /process\.env\.(?!NODE_ENV\b)\w+/, /import\.meta\.env\.\w*(?:KEY|SECRET|TOKEN|PASSWORD)/i,
    /from\s+['"](?:@ibujs\/(?:ai|server)|@anthropic-ai\/sdk|openai)['"]/, /import\(\s*['"](?:@ibujs\/(?:ai|server)|@anthropic-ai\/sdk)['"]\s*\)/
  ] },
  { id: 'IBU703', severity: 'error', scope: 'any', message: 'Raw HTML sink (XSS risk)', patterns: [
    /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)/, /\binsertAdjacentHTML\s*\(/, /\bdocument\.write(?:ln)?\s*\(/, /dangerouslySetInnerHTML/, /\bsrcdoc\s*[=:]/
  ] },
  { id: 'IBU704', severity: 'error', scope: 'any', message: 'Dynamic code execution', patterns: [
    /(?:^|[^\w.$])eval\s*\(/, /\bnew\s+Function\s*\(/, /\bset(?:Timeout|Interval)\s*\(\s*['"`]/
  ] },
  { id: 'IBU705', severity: 'error', scope: 'any', message: 'SQL built from strings (SQL injection risk)', patterns: [
    /\.(?:raw|query|exec|prepare)\s*\(\s*`[^`]*\$\{/,
    /\.(?:raw|query|exec|prepare)\s*\(\s*(['"])[^'"]*\1\s*\+/,
    r(String.raw`(?<!sql)\x60\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^\x60]*\$\{`, 'i'),
    /['"]\s*(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^'"]*['"]\s*\+/i
  ] },
  { id: 'IBU706', severity: 'error', scope: 'server', message: 'Shell command built from strings (command injection risk)', patterns: [
    /\b(?:exec|execSync)\s*\(\s*`[^`]*\$\{/, /\b(?:exec|execSync)\s*\([^)]*\+/, /\bshell\s*:\s*true\b/
  ] },
  { id: 'IBU707', severity: 'warning', scope: 'server', message: 'File path built from request data (path traversal risk)', patterns: [
    /\b(?:readFile|readFileSync|createReadStream|writeFile|writeFileSync|appendFile|unlink|rm|rmSync|sendFile|open)\s*\([^)]*\b(?:ctx\.(?:params|query)|req\.(?:params|query|url)|searchParams)/
  ] },
  { id: 'IBU708', severity: 'warning', scope: 'server', message: 'Request body used without a schema', patterns: [/ctx\.body\s*(?:<[^>]*>)?\(\s*\)/] },
  { id: 'IBU709', severity: 'warning', scope: 'server', message: 'External redirects allowed', patterns: [/allowExternal\s*:\s*true/] },
  { id: 'IBU710', severity: 'warning', scope: 'server', message: 'Math.random() is not safe for tokens, ids or codes', patterns: [/Math\.random\s*\(/] },
  { id: 'IBU711', severity: 'warning', scope: 'any', message: 'Weak hash algorithm', patterns: [/createHash\s*\(\s*['"](?:md5|sha1)['"]/i] },
  { id: 'IBU712', severity: 'error', scope: 'any', message: 'Security protection disabled', patterns: [/\bcsrf\s*:\s*false/, /rejectUnauthorized\s*:\s*false/, /NODE_TLS_REJECT_UNAUTHORIZED/] },
  { id: 'IBU713', severity: 'warning', scope: 'server', message: 'CORS allows every origin', patterns: [/origins\s*:\s*\[\s*['"]\*['"]/, /Access-Control-Allow-Origin['"]?\s*[,:]\s*['"]\*['"]/i] },
  { id: 'IBU714', severity: 'warning', scope: 'any', message: 'Signal changed in place, so the page will not update', patterns: [
    /\.value\s*\.\s*(?:push|pop|shift|unshift|splice|sort|reverse|fill)\s*\(/, /\.value\s*\[[^\]]+\]\s*=(?!=)/
  ] },
  { id: 'IBU716', severity: 'error', scope: 'server', message: 'Session secret written in code', patterns: [/createSessionManager\s*\(\s*(?:\{\s*secret\s*:\s*)?['"`]/] }
];

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'packages']);

// Decides whether a file runs in the browser, on the server, or could be either.
// Browser signals win over server imports: a .tsx file importing @ibujs/ai is exactly the leak to catch.
export function fileKind(path, text) {
  if (/(^|[\\/])(server|api|backend)([\\/.]|$)/i.test(path)) return 'server';
  if (/\.(?:tsx|jsx)$/.test(path) || /from\s+['"]@ibujs\/ui['"]/.test(text)) return 'client';
  if (/from\s+['"](?:@ibujs\/(?:server|ai)|node:)/.test(text)) return 'server';
  return 'any';
}

const isComment = line => /^\s*(?:\/\/|\/\*|\*)/.test(line);
const ignored = (line, id) => { const m = /ibu-ignore(?:\s+([\w ,]+))?/.exec(line); return !!m && (!m[1] || m[1].split(/[\s,]+/).includes(id)); };

export function scanSource(text, file = 'input.ts', kind = fileKind(file, text)) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.scope !== 'any' && rule.scope !== kind && kind !== 'any') continue;
      if (rule.scope === 'client' && kind === 'any') continue;
      if (!rule.comments && isComment(line)) continue;
      if (ignored(line, rule.id) || (i > 0 && isComment(lines[i - 1]) && ignored(lines[i - 1], rule.id))) continue;
      for (const pattern of rule.patterns) {
        const match = pattern.exec(line);
        if (match) {
          findings.push({ file, line: i + 1, column: match.index + 1, rule: rule.id, severity: rule.severity, message: rule.message, snippet: line.trim().slice(0, 160) });
          break;
        }
      }
    }
  });
  return findings;
}

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) out.push(full);
  }
  return out;
}

export async function scanProject(root, targets) {
  const files = [];
  for (const target of targets) {
    const full = resolve(root, target);
    if (!existsSync(full)) continue;
    if ((await stat(full)).isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  const findings = [];
  for (const file of [...new Set(files)]) {
    const text = await readFile(file, 'utf8');
    findings.push(...scanSource(text, relative(root, file).split(sep).join('/')));
  }
  // Project-level: secrets file that git would commit.
  if (existsSync(join(root, '.env'))) {
    const gitignore = existsSync(join(root, '.gitignore')) ? await readFile(join(root, '.gitignore'), 'utf8') : '';
    if (!gitignore.split(/\r?\n/).some(l => /^\/?\.env(\*|\.\*)?$/.test(l.trim()))) {
      findings.push({ file: '.gitignore', line: 1, column: 1, rule: 'IBU715', severity: 'error', message: '.env is not git-ignored', snippet: '' });
    }
  }
  return { files: files.length, findings };
}

const color = (code, text) => process.stdout.isTTY && !process.env.NO_COLOR ? `\x1b[${code}m${text}\x1b[0m` : text;

export function formatFindings({ files, findings }, catalog = {}) {
  if (!findings.length) return color('32', `✔ No security problems found in ${files} file${files === 1 ? '' : 's'}.`);
  const lines = findings.map(f => {
    const level = f.severity === 'error' ? color('31', 'error  ') : color('33', 'warning');
    const fix = catalog[f.rule]?.fix ? `\n    ${color('2', 'fix: ' + catalog[f.rule].fix)}` : '';
    return `${color('1', `${f.file}:${f.line}:${f.column}`)}  ${level}  ${f.rule}  ${f.message}${f.snippet ? `\n    ${f.snippet}` : ''}${fix}`;
  });
  const errors = findings.filter(f => f.severity === 'error').length;
  const warnings = findings.length - errors;
  return `${lines.join('\n\n')}\n\n${color(errors ? '31' : '33', `✖ ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}`)} in ${files} files. Details: npx ibu explain <code>`;
}
