// Every IbuJS error carries a stable code (e.g. IBU101). Run `npx ibu explain IBU101`
// for a plain-English explanation and fix, or `npx ibu explain IBU101 --ai` for a tailored one.
export class IbuError extends Error {
  readonly code: string;
  readonly hint?: string;
  status?: number;
  constructor(code: string, message: string, hint?: string) {
    super(`[${code}] ${message}${hint ? `\n  Hint: ${hint}` : ''}\n  More: npx ibu explain ${code}`);
    this.name = 'IbuError';
    this.code = code;
    this.hint = hint;
  }
}

// True unless the bundler replaced process.env.NODE_ENV with "production".
export const DEV: boolean = (() => {
  try { return process.env.NODE_ENV !== 'production'; } catch { return true; }
})();

export interface SecurityViolation { code: string; message: string; tag?: string; attribute?: string; value?: string }
type ViolationHandler = (violation: SecurityViolation) => void;
const defaultHandler: ViolationHandler = v => {
  if (DEV) console.warn(`[${v.code}] ${v.message}\n  More: npx ibu explain ${v.code}`);
};
let violationHandler: ViolationHandler = defaultHandler;

// Called whenever IbuJS neutralises unsafe data (for example a javascript: URL from user input).
// Use it to log attacks, or make violations throw in tests. Pass null to restore the default.
export function onSecurityViolation(handler: ViolationHandler | null) {
  violationHandler = handler ?? defaultHandler;
}
export function reportViolation(violation: SecurityViolation) {
  violationHandler(violation);
}
