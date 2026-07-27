// In-memory cache for assembled guides.
//
// Assembling a guide means scraping Wikivoyage, OSM, Lonely Planet, Reddit and
// friends live, then ranking the result — measured at 19s for a tracked city and
// 53s for a new one, with NO reuse between identical requests. Every visitor
// paid that in full, which is what made the app feel broken from a slow or
// distant connection.
//
// Strategy is stale-while-revalidate: a warm entry is served instantly, and a
// stale one is ALSO served instantly while a refresh runs in the background. A
// visitor should essentially never wait on assembly except for a genuinely
// cold place.
//
// Deliberately in-memory rather than on the volume: the machine is always-on so
// the cache survives normally, entries are large, and a stale guide after a
// deploy is not worth the disk-write complexity.

const FRESH_MS = 6 * 60 * 60 * 1000; // serve without refreshing
const MAX_ENTRIES = 120; // bounded so a crawler can't exhaust memory

interface Entry<T> {
  value: T;
  storedAt: number;
  refreshing: boolean;
}

const cache = new Map<string, Entry<unknown>>();

export interface CacheOutcome<T> {
  value: T;
  /** 'miss' blocked on assembly; 'hit' and 'stale' were served instantly. */
  status: 'hit' | 'stale' | 'miss';
  ageMs: number;
}

function evictOldest() {
  if (cache.size <= MAX_ENTRIES) return;
  let oldestKey: string | null = null;
  let oldest = Infinity;
  for (const [k, v] of cache) {
    if (v.storedAt < oldest) {
      oldest = v.storedAt;
      oldestKey = k;
    }
  }
  if (oldestKey) cache.delete(oldestKey);
}

export async function cachedGuide<T>(
  key: string,
  build: () => Promise<T>,
): Promise<CacheOutcome<T>> {
  const hit = cache.get(key) as Entry<T> | undefined;
  const now = Date.now();

  if (hit) {
    const age = now - hit.storedAt;
    if (age < FRESH_MS) return { value: hit.value, status: 'hit', ageMs: age };

    // Stale: hand back the old guide immediately and refresh behind the user.
    if (!hit.refreshing) {
      hit.refreshing = true;
      void build()
        .then((fresh) => {
          cache.set(key, { value: fresh, storedAt: Date.now(), refreshing: false });
          evictOldest();
        })
        .catch(() => {
          // Keep serving the stale entry; just allow a later retry.
          hit.refreshing = false;
        });
    }
    return { value: hit.value, status: 'stale', ageMs: age };
  }

  // Cold: this request has to wait.
  const value = await build();
  cache.set(key, { value, storedAt: Date.now(), refreshing: false });
  evictOldest();
  return { value, status: 'miss', ageMs: 0 };
}

export function guideCacheStats() {
  return {
    entries: cache.size,
    keys: [...cache.keys()].slice(0, 50),
  };
}
