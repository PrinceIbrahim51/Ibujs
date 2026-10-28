import { IbuError } from '@ibumomujs/ui';
import { HttpError } from './app.js';
import type { Session } from './auth.js';

// Authorization: who may do what to which record. Sessions tell you *who* someone is;
// policies decide *what* they may touch. Everything not explicitly allowed is denied.
//
//   const notes = definePolicy<Note>({
//     read: anyOf(owner('owner_id'), (user, note) => note.is_public),
//     update: owner('owner_id'),
//     delete: anyOf(owner('owner_id'), role('admin'))
//   });
//   await notes.authorize(user, 'update', note);   // 401 / 403 (or 404 with { hide: true })

export interface Actor { id: string; roles?: readonly string[] }
export type Rule<R> = boolean | ((actor: Actor | null, resource: R) => boolean | Promise<boolean>);

function checkRule(name: string, rule: unknown) {
  if (typeof rule !== 'boolean' && typeof rule !== 'function') {
    throw new IbuError('IBU507', `Policy rule "${name}" must be true, false or a function.`, 'Example: update: owner("owner_id")');
  }
}

async function evaluate<R>(rule: Rule<R>, actor: Actor | null, resource: R): Promise<boolean> {
  return typeof rule === 'boolean' ? rule : (await rule(actor, resource)) === true;
}

// Allows the actor whose id equals resource[field] (compared as strings, so numeric ids work).
export function owner<R>(field: keyof R & string = 'owner_id' as keyof R & string): Rule<R> {
  return (actor, resource) => actor != null && resource != null && resource[field] != null && String(resource[field]) === actor.id;
}

// Allows actors that have at least one of the roles.
export function role<R = unknown>(...roles: string[]): Rule<R> {
  return actor => actor != null && roles.some(r => actor.roles?.includes(r));
}

// Allows any logged-in actor. Generic, so anyOf/allOf still infer the record type from the policy.
export const loggedIn = <R>(actor: Actor | null, _resource?: R): boolean => actor != null;

// R comes from the policy (definePolicy<Note>), so rules inside get typed records.
export function anyOf<R>(...rules: Rule<NoInfer<R>>[]): Rule<R> {
  rules.forEach((r, i) => checkRule(`anyOf[${i}]`, r));
  return async (actor, resource) => { for (const r of rules) if (await evaluate(r, actor, resource)) return true; return false; };
}

export function allOf<R>(...rules: Rule<NoInfer<R>>[]): Rule<R> {
  rules.forEach((r, i) => checkRule(`allOf[${i}]`, r));
  return async (actor, resource) => { for (const r of rules) if (!await evaluate(r, actor, resource)) return false; return true; };
}

// Turns a session into an actor. Roles can be stored at login as a comma-separated string:
// sessions.login(ctx, String(user.id), { roles: 'admin,editor' }). For roles that change often,
// load them from your database per request instead.
export function actorFromSession(session: Session | null | undefined): Actor | null {
  if (!session) return null;
  const roles = typeof session.data?.roles === 'string' ? session.data.roles.split(',').map(r => r.trim()).filter(Boolean) : [];
  return { id: session.sub, roles };
}

export function definePolicy<R, A extends string = string>(rules: Record<A, Rule<R>>) {
  for (const [name, rule] of Object.entries(rules)) checkRule(name, rule);
  const can = (actor: Actor | null, action: A, resource: R): Promise<boolean> => {
    if (!Object.hasOwn(rules, action)) return Promise.resolve(false);
    return evaluate(rules[action], actor, resource);
  };
  return {
    can,
    // Throws 401 when nobody is logged in, 403 when the action is not allowed.
    // { hide: true } answers 404 to everyone instead, so nobody can probe which records exist.
    async authorize(actor: Actor | null, action: A, resource: R, options: { hide?: boolean } = {}): Promise<void> {
      if (await can(actor, action, resource)) return;
      if (options.hide) throw new HttpError(404, 'Not found', { code: 'IBU404' });
      if (!actor) throw new HttpError(401, 'Please log in first', { code: 'IBU503' });
      throw new HttpError(403, `You are not allowed to ${action} this`, { code: 'IBU506' });
    },
    // Keeps only the records the actor may act on, e.g. before returning a list.
    async filter(actor: Actor | null, action: A, resources: readonly R[]): Promise<R[]> {
      const allowed = await Promise.all(resources.map(r => can(actor, action, r)));
      return resources.filter((_, i) => allowed[i]);
    }
  };
}
