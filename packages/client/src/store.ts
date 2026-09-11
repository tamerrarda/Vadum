// The persistence seam (26-SPEC, D32). Deliberately minimal: `client` runs in a browser over IndexedDB
// and in Node over a test double, and neither pool nor queue may assume which. Stream C supplies the
// browser implementation; this file ships the in-memory one.

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  keys(prefix: string): Promise<readonly string[]>;
}

/**
 * In-memory, for tests. Values are cloned on the way in and out, so a caller holding a reference
 * cannot mutate stored state without going through `set` — the browser store behaves that way too,
 * and slot state that changed without being persisted is exactly the D32 failure.
 */
export function createMemoryStore(): KeyValueStore {
  const entries = new Map<string, unknown>();
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const value = entries.get(key);
      return value === undefined ? undefined : (structuredClone(value) as T);
    },
    async set<T>(key: string, value: T): Promise<void> {
      entries.set(key, structuredClone(value));
    },
    async delete(key: string): Promise<void> {
      entries.delete(key);
    },
    async keys(prefix: string): Promise<readonly string[]> {
      return [...entries.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
  };
}
