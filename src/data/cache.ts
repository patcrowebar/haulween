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
