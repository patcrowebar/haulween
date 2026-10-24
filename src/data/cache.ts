// A small cache for the free services: memory first, then sessionStorage so a reload doesn't
// ask again. Storage can be missing or full (private windows); the cache then just forgets.

export class SessionCache<T> {
  private mem = new Map<string, T>();
  constructor(private prefix: string, private storage: Storage | null = safeSessionStorage()) {}

  get(key: string): T | undefined {
    if (this.mem.has(key)) return this.mem.get(key);
    try {
      const raw = this.storage?.getItem(this.prefix + key);
      if (raw != null) {
        const value = JSON.parse(raw) as T;
        this.mem.set(key, value);
        return value;
      }
    } catch {
      // unreadable: treat as a miss
    }
    return undefined;
  }

  set(key: string, value: T): void {
    this.mem.set(key, value);
    try {
      this.storage?.setItem(this.prefix + key, JSON.stringify(value));
    } catch {
      // full or blocked: memory still has it
    }
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** A failure we can explain to a parent in plain words. */
export class ServiceError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/**
 * Why a request failed, so the message can say what to do about it.
 * - busy: the service said so, with a real 429 or 504.
 * - down: it answered with some other error (a 5xx, or an error page or note).
 * - unreachable: no answer reached the page at all while the device is online. Browsers report a
 *   refused, blocked or dropped request the same way ("Load failed", "Failed to fetch"), so this
 *   says only that, not why.
 * - timeout: no full answer in time. offline: the device has no connection.
 * - bad: an answer we couldn't read.
 */
export type FailKind = 'offline' | 'busy' | 'down' | 'unreachable' | 'timeout' | 'bad';

/** When two servers fail differently, the one to tell the parent: the most useful first. */
export const FAIL_ORDER: readonly FailKind[] = ['offline', 'busy', 'down', 'timeout', 'unreachable', 'bad'];
export const worstOf = (kinds: FailKind[]): FailKind => FAIL_ORDER.find((k) => kinds.includes(k)) ?? 'bad';

export class RequestError extends ServiceError {
  constructor(message: string, readonly kind: FailKind, status?: number) {
    super(message, status);
  }
}

export class TimeoutError extends Error {
  name = 'TimeoutError';
}

/**
 * fetch with a time limit that covers the whole answer, body included. Aborts the request and
 * rejects with TimeoutError when it runs out; other failures reject as fetch would.
 */
export async function fetchTextWithin(
  fetchFn: typeof fetch, url: string, init: RequestInit, ms: number,
): Promise<{ res: Response; text: string }> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new TimeoutError(`no answer in ${ms} ms`));
    }, ms);
  });
  const answer = (async () => {
    const res = await fetchFn(url, { ...init, signal: ctl.signal });
    return { res, text: await res.text() };
  })();
  answer.catch(() => {}); // once the limit wins, a late failure here is expected and ignored
  try {
    return await Promise.race([answer, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** A real network failure, or a service refusing us? Browsers report both as a TypeError. */
export const browserIsOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
