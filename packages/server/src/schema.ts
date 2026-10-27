import { HttpError } from './app.js';

// A tiny, dependency-free validator. Every schema both checks and *types* the data:
//   const NewNote = s.object({ text: s.string({ min: 1, max: 200 }) });
//   const { text } = await ctx.body(NewNote);   // text: string, guaranteed 1-200 chars
// Unknown keys are dropped, so clients cannot sneak in fields such as { isAdmin: true }.

export interface Issue { path: string; message: string }
export class ValidationError extends HttpError {
  constructor(readonly issues: Issue[]) {
    super(400, issues.length === 1 ? `${issues[0].path || 'value'}: ${issues[0].message}` : `${issues.length} fields are invalid`, { code: 'IBU415' });
  }
}

type Check<T> = (value: unknown, path: string, issues: Issue[]) => T;
export class Schema<T> {
  constructor(readonly check: Check<T>) {}
  parse(value: unknown): T {
    const issues: Issue[] = [];
    const result = this.check(value, '', issues);
    if (issues.length) throw new ValidationError(issues);
    return result;
  }
  safeParse(value: unknown): { ok: true; value: T } | { ok: false; issues: Issue[] } {
    const issues: Issue[] = [];
    const result = this.check(value, '', issues);
    return issues.length ? { ok: false, issues } : { ok: true, value: result };
  }
  optional(): Schema<T | undefined> {
    return new Schema((value, path, issues) => value === undefined || value === null ? undefined : this.check(value, path, issues));
  }
  default(fallback: T): Schema<T> {
    return new Schema((value, path, issues) => value === undefined || value === null ? fallback : this.check(value, path, issues));
  }
}
export type Infer<S> = S extends Schema<infer T> ? T : never;

const at = (path: string, key: string | number) => typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;
const fail = (issues: Issue[], path: string, message: string) => { issues.push({ path, message }); return undefined as never; };
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

interface StringOptions { min?: number; max?: number; pattern?: RegExp; trim?: boolean; email?: boolean; url?: boolean }
interface NumberOptions { min?: number; max?: number; integer?: boolean; coerce?: boolean }

type Shape = Record<string, Schema<unknown>>;
type Simplify<T> = { [K in keyof T]: T[K] } & {};
type ObjectOutput<S extends Shape> = Simplify<
  { [K in keyof S as undefined extends Infer<S[K]> ? never : K]: Infer<S[K]> } &
  { [K in keyof S as undefined extends Infer<S[K]> ? K : never]?: Infer<S[K]> }
>;

export const s = {
  // Strings are trimmed and capped at 10,000 characters unless you say otherwise.
  string(options: StringOptions = {}): Schema<string> {
    const { min = 0, max = 10_000, trim = true } = options;
    return new Schema((value, path, issues) => {
      if (typeof value !== 'string') return fail(issues, path, 'must be text');
      const text = trim ? value.trim() : value;
      if (text.length < min) return fail(issues, path, min === 1 ? 'is required' : `must be at least ${min} characters`);
      if (text.length > max) return fail(issues, path, `must be at most ${max} characters`);
      if (options.pattern && !options.pattern.test(text)) return fail(issues, path, 'has an invalid format');
      if (options.email && (text.length > 254 || !EMAIL.test(text))) return fail(issues, path, 'must be a valid email address');
      if (options.url) {
        let ok = false;
        try { ok = ['http:', 'https:'].includes(new URL(text).protocol); } catch { /* invalid */ }
        if (!ok) return fail(issues, path, 'must be an http(s) URL');
      }
      return text;
    });
  },
  number(options: NumberOptions = {}): Schema<number> {
    return new Schema((value, path, issues) => {
      const n = options.coerce && typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return fail(issues, path, 'must be a number');
      if (options.integer && !Number.isInteger(n)) return fail(issues, path, 'must be a whole number');
      if (options.min !== undefined && n < options.min) return fail(issues, path, `must be at least ${options.min}`);
      if (options.max !== undefined && n > options.max) return fail(issues, path, `must be at most ${options.max}`);
      return n;
    });
  },
  boolean(): Schema<boolean> {
    return new Schema((value, path, issues) => typeof value === 'boolean' ? value : fail(issues, path, 'must be true or false'));
  },
  enum<const T extends readonly [string, ...string[]]>(values: T): Schema<T[number]> {
    return new Schema((value, path, issues) => (values as readonly unknown[]).includes(value) ? value as T[number] : fail(issues, path, `must be one of: ${values.join(', ')}`));
  },
  // A URL-safe identifier, handy for route params: s.id().parse(ctx.params.id)
  id(): Schema<string> {
    return s.string({ min: 1, max: 128, pattern: /^[A-Za-z0-9_-]+$/ });
  },
  array<T>(item: Schema<T>, options: { min?: number; max?: number } = {}): Schema<T[]> {
    const { min = 0, max = 1000 } = options;
    return new Schema((value, path, issues) => {
      if (!Array.isArray(value)) return fail(issues, path, 'must be a list');
      if (value.length < min) return fail(issues, path, `must have at least ${min} items`);
      if (value.length > max) return fail(issues, path, `must have at most ${max} items`);
      return value.map((v, i) => item.check(v, at(path, i), issues));
    });
  },
  object<S extends Shape>(shape: S, options: { strict?: boolean } = {}): Schema<ObjectOutput<S>> {
    return new Schema((value, path, issues) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(issues, path, 'must be an object');
      const input = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) {
        const v = shape[key].check(Object.hasOwn(input, key) ? input[key] : undefined, at(path, key), issues);
        if (v !== undefined) result[key] = v;
      }
      if (options.strict) for (const key of Object.keys(input)) if (!Object.hasOwn(shape, key)) fail(issues, at(path, key), 'is not allowed');
      return result as ObjectOutput<S>;
    });
  }
};

// v0.5 API, kept for compatibility: validateObject(body, { text: 'string' })
export function validateObject(value: unknown, schema: Record<string, 'string' | 'number' | 'boolean'>): Record<string, unknown> {
  const shape: Shape = {};
  for (const [key, type] of Object.entries(schema)) shape[key] = type === 'string' ? s.string({ trim: false }) : type === 'number' ? s.number() : s.boolean();
  return s.object(shape).parse(value);
}
