// The visitor's Claude key: kept in this browser only, easy to forget, and no key means no Jack.
import { describe, expect, it } from 'vitest';
import { forgetKey, loadKey, saveKey } from './key';

/** An in-memory Storage. */
function storage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, v); },
  };
}

// Made up, the right shape only.
const FAKE = 'sk-ant-test-0000000000000000';

describe('the Claude key', () => {
  it('is absent until saved, so Jack stays hidden', () => {
    expect(loadKey(storage())).toBeNull();
    expect(loadKey(null)).toBeNull();
  });

  it('saves a pasted key (trimmed) and forgets it', () => {
    const s = storage();
    expect(saveKey(`  ${FAKE}\n`, s)).toBeNull();
    expect(loadKey(s)).toBe(FAKE);
    forgetKey(s);
    expect(loadKey(s)).toBeNull();
    expect(s.length).toBe(0);
  });

  it("refuses something that isn't a key, in plain words", () => {
    const s = storage();
    for (const bad of ['', 'hello', 'sk-ant- with spaces', '1428 Elm St, Springwood, OH']) {
      expect(saveKey(bad, s)).toMatch(/doesn't look like a Claude API key/);
    }
    expect(s.length).toBe(0);
  });

  it('says so when the browser blocks storage', () => {
    const blocked = { ...storage(), setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(saveKey(FAKE, blocked)).toMatch(/wouldn't save the key/);
    expect(saveKey(FAKE, null)).toMatch(/wouldn't save the key/);
  });

  it('ignores a damaged saved value', () => {
    const s = storage();
    s.setItem('haulween.claude.key', 'not a key');
    expect(loadKey(s)).toBeNull();
  });
});
