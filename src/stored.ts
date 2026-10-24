// Reading back what an earlier visit saved. Anything in localStorage or sessionStorage may have
// been written by an older version of the app, with fields missing, renamed or of another type,
// so every load goes through here: each field keeps the saved value only if it has the same
// type as the default, and takes the default otherwise.

const kind = (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/** `saved`, field by field, with `defaults` filling in anything missing or of the wrong type. */
export function withDefaults<T extends object>(saved: unknown, defaults: T): T {
  const out = { ...defaults };
  if (kind(saved) !== 'object') return out;
  const s = saved as Record<string, unknown>;
  for (const k of Object.keys(defaults) as Array<keyof T & string>) {
    if (kind(s[k]) === kind(defaults[k])) out[k] = s[k] as T[typeof k];
  }
  return out;
}

export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
