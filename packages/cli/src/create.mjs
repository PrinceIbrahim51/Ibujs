import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// packages/cli -> the workspace that contains packages/ (the framework repo, or an app made by `ibu create`).
const frameworkRoot = resolve(cliRoot, '../..');
const template = join(cliRoot, 'template');

export const newSecret = () => randomBytes(32).toString('base64url');

export async function create(name, cwd) {
  if (!name || !/^[a-z][a-z0-9-]{1,48}$/.test(name)) throw new Error('Usage: npx ibu create my-app  (lowercase letters, numbers and hyphens)');
  const dest = resolve(cwd, name);
  if (existsSync(dest)) throw new Error(`A folder named "${name}" already exists here.`);
  const version = JSON.parse(await readFile(join(cliRoot, 'package.json'), 'utf8')).version;
  await mkdir(dest, { recursive: true });

  // The framework is vendored as local workspace packages, so the app works offline and is easy to inspect.
  for (const pkg of ['ui', 'server', 'ai', 'cli']) {
    await cp(join(frameworkRoot, 'packages', pkg), join(dest, 'packages', pkg), { recursive: true, filter: src => !src.includes('node_modules') });
  }
  for (const item of ['index.html', 'src', 'public', 'AGENTS.md', 'CLAUDE.md']) {
    if (existsSync(join(template, item))) await cp(join(template, item), join(dest, item), { recursive: true });
  }
  // The compact API reference that AI assistants (and `ibu ai`) read.
  await cp(join(frameworkRoot, 'llms.txt'), join(dest, 'llms.txt'));
  const write = (file, text) => writeFile(join(dest, file), text);
  await write('package.json', JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    workspaces: ['packages/*'],
    scripts: {
      dev: 'ibu dev',
      build: 'ibu build',
      start: 'ibu start',
      check: 'ibu check',
      typecheck: 'tsc --noEmit',
      doctor: 'ibu doctor'
    },
    // "*" always resolves to the vendored workspace copies in packages/.
    dependencies: { '@ibujs/ai': '*', '@ibujs/server': '*', '@ibujs/ui': '*' },
    devDependencies: { '@ibujs/cli': '*', '@types/node': '^22.20.5', typescript: '^5.9.3' },
    engines: { node: '>=22.13' }
  }, null, 2) + '\n');
  await write('ibu.config.json', JSON.stringify({ client: 'src/main.tsx', server: 'src/server.ts', html: 'index.html' }, null, 2) + '\n');
  await write('tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true,
      jsx: 'react-jsx', jsxImportSource: '@ibujs/ui', lib: ['ES2022', 'DOM', 'DOM.Iterable'], types: ['node'],
      skipLibCheck: true, allowImportingTsExtensions: true
    },
    include: ['src']
  }, null, 2) + '\n');
  await write('.gitignore', 'node_modules/\ndist/\n.env\n.env.*\n!.env.example\n*.db\n*.db-*\n*.log\n.DS_Store\n');
  await write('.env.example', 'PORT=3000\nHOST=127.0.0.1\n# Generate with: npx ibu secret\nSESSION_SECRET=\n# Optional, for AI features and `npx ibu ai`: https://platform.claude.com\nANTHROPIC_API_KEY=\n');
  // A real, random secret from the start; .env is git-ignored above.
  await write('.env', `PORT=3000\nHOST=127.0.0.1\nSESSION_SECRET=${newSecret()}\nANTHROPIC_API_KEY=\n`);
  await write('README.md', `# ${name}\n\nBuilt with IbuJS ${version}.\n\n\`\`\`bash\nnpm install\nnpm run dev        # http://127.0.0.1:3000\n\`\`\`\n\n| Command | What it does |\n|---|---|\n| \`npm run dev\` | Start the app and reload on changes |\n| \`npm run build\` / \`npm start\` | Production build / run it |\n| \`npm run check\` | Security check of your code |\n| \`npx ibu ai "add a contact form"\` | Ask Claude to make a change (needs ANTHROPIC_API_KEY) |\n| \`npx ibu review\` | AI security review of your code |\n| \`npx ibu explain IBU412\` | Explain an error code |\n| \`npx ibu doctor\` | Diagnose setup problems |\n\nSecrets live in \`.env\` (never commit it). Coding with an AI assistant? It will read AGENTS.md.\n`);
  console.log(`\n✔ Created ${name}\n\n  cd ${name}\n  npm install\n  npm run dev\n\nA random SESSION_SECRET was written to ${name}/.env (git-ignored).`);
}
