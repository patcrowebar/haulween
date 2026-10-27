// The visitor's own Claude API key, for Jack. Kept only in this browser (localStorage) and sent
// only to Claude's API (jack.ts). Once saved it's never shown on screen again, and never logged.
// No key, no Jack: the rest of the app never looks at this.

const KEY = 'haulween.claude.key';

const local = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // storage blocked
  }
};

/** The saved key, or null. */
export function loadKey(store: Storage | null = local()): string | null {
  try {
    const k = store?.getItem(KEY);
    return k && isKeyShaped(k) ? k : null;
  } catch {
    return null;
  }
}

/** Claude API keys start with "sk-ant-" and have no spaces. */
export const isKeyShaped = (k: string) => /^sk-ant-[A-Za-z0-9_-]{8,}$/.test(k);

/** Save a pasted key. Returns a message for the parent if it can't be saved. */
export function saveKey(pasted: string, store: Storage | null = local()): string | null {
  const k = pasted.trim();
  if (!isKeyShaped(k)) return "That doesn't look like a Claude API key. They start with sk-ant-.";
  try {
    if (!store) throw new Error('no storage');
    store.setItem(KEY, k);
    return null;
  } catch {
    return "This browser wouldn't save the key (private browsing can block it).";
  }
}

export function forgetKey(store: Storage | null = local()): void {
  try {
    store?.removeItem(KEY);
  } catch {
    // nothing kept
  }
}
