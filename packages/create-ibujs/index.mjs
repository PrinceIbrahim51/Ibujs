#!/usr/bin/env node
// `npm create ibujs@latest my-app` runs this, which runs `ibu create my-app`.
import { create } from '@ibujs/cli/create';

const [name, ...flags] = process.argv.slice(2);
create(name, process.cwd(), { mode: flags.includes('--vendor') ? 'vendor' : flags.includes('--npm') ? 'npm' : undefined })
  .catch(err => { console.error(err.message); process.exitCode = 1; });
