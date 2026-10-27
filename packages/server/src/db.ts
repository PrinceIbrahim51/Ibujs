import { IbuError } from '@ibujs/ui';

// SQL injection is impossible by construction: values in sql`...` are always sent to the database
// separately from the query text, never pasted into it.
//   await db.sql`SELECT * FROM notes WHERE owner = ${userId} ORDER BY id DESC`

const SQL: unique symbol = Symbol.for('ibujs.sql');
export interface SqlQuery { readonly [SQL]: true; readonly strings: readonly string[]; readonly values: readonly unknown[] }

export function isSql(value: unknown): value is SqlQuery {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[SQL] === true;
}

export function sql(strings: TemplateStringsArray | readonly string[], ...values: unknown[]): SqlQuery {
  // Nested sql`` fragments are spliced in, so queries can be composed safely.
  const outStrings = [strings[0]];
  const outValues: unknown[] = [];
  values.forEach((value, i) => {
    if (isSql(value)) {
      outStrings[outStrings.length - 1] += value.strings[0];
      value.values.forEach((v, j) => { outValues.push(v); outStrings.push(value.strings[j + 1]); });
      outStrings[outStrings.length - 1] += strings[i + 1];
    } else {
      outValues.push(value);
      outStrings.push(strings[i + 1]);
    }
  });
  return { [SQL]: true, strings: outStrings, values: outValues };
}

// For dynamic column/table names, which cannot be parameters: sql`ORDER BY ${sql.identifier(column)}`.
// Only plain identifiers are accepted; still validate them against an allowlist of your columns.
sql.identifier = (name: string): SqlQuery => {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(name)) throw new IbuError('IBU601', `"${name}" is not a safe SQL identifier.`, 'Check the name against a list of allowed column names before using it.');
  return sql([`"${name}"`]);
};
sql.join = (parts: SqlQuery[], separator = ', '): SqlQuery => {
  if (!parts.length) return sql(['']);
  return parts.slice(1).reduce((acc, part) => sql(['', separator, ''], acc, part), parts[0]);
};

export function toText(query: SqlQuery, style: '?' | '$' = '?'): string {
  return query.strings.reduce((text, part, i) => text + (i === 0 ? '' : style === '$' ? `$${i}` : '?') + part, '');
}

export interface DatabaseAdapter {
  query<T = unknown>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  close(): Promise<void>;
  // Postgres uses $1, $2…; SQLite and MySQL use ?.
  placeholder?: '?' | '$';
}

export function createDatabase(adapter: DatabaseAdapter) {
  const run = <T>(query: SqlQuery) => adapter.query<T>(toText(query, adapter.placeholder), query.values);
  return {
    sql: <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => run<T>(sql(strings, ...values)),
    query<T = Record<string, unknown>>(query: SqlQuery): Promise<T[]> {
      if (!isSql(query)) {
        throw new IbuError('IBU602', 'db.query() only accepts queries built with sql`...`.', 'Write db.sql`SELECT * FROM notes WHERE id = ${id}` — values are sent separately, so SQL injection cannot happen. For hand-written parameterised SQL use db.raw(text, params).');
      }
      return run<T>(query);
    },
    // Escape hatch for hand-written SQL with placeholders. Never build `text` from user input; `npx ibu check` flags it.
    raw: <T = Record<string, unknown>>(text: string, params: readonly unknown[] = []) => adapter.query<T>(text, params),
    close: () => adapter.close()
  };
}
export type Database = ReturnType<typeof createDatabase>;

// Zero-install persistent database using Node's built-in SQLite (Node 22.13+).
// Tip: add RETURNING * to INSERT/UPDATE statements to get the affected rows back.
export async function sqliteDatabase(filename = 'data.db'): Promise<Database> {
  let mod: typeof import('node:sqlite');
  try { mod = await import('node:sqlite'); }
  catch { throw new IbuError('IBU603', 'SQLite is not available in this Node.js version.', 'Upgrade to Node.js 22.13 or newer, or pass your own adapter to createDatabase().'); }
  const db = new mod.DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  const toSqlite = (v: unknown) => v === undefined ? null : typeof v === 'boolean' ? Number(v) : v instanceof Date ? v.toISOString() : v;
  return createDatabase({
    async query<T>(text: string, params: readonly unknown[] = []) {
      return db.prepare(text).all(...params.map(toSqlite) as never[]) as T[];
    },
    async close() { db.close(); }
  });
}

// In-memory store for prototypes and tests. Data is lost when the process restarts.
export function memoryDatabase<T extends Record<string, unknown> = Record<string, unknown>>(initial: T[] = []) {
  let nextId = 1;
  const records: Array<T & { id: number }> = initial.map(row => ({ ...row, id: nextId++ }));
  const copy = (row: T & { id: number }) => ({ ...row });
  return {
    all: () => records.map(copy),
    find: (id: number) => { const row = records.find(r => r.id === id); return row ? copy(row) : undefined; },
    insert: (row: T) => { const stored = { ...row, id: nextId++ }; records.push(stored); return copy(stored); },
    update: (id: number, changes: Partial<T>) => {
      const row = records.find(r => r.id === id);
      if (!row) return undefined;
      Object.assign(row, changes, { id });
      return copy(row);
    },
    remove: (id: number) => { const i = records.findIndex(r => r.id === id); if (i < 0) return false; records.splice(i, 1); return true; },
    clear: () => { records.length = 0; }
  };
}
