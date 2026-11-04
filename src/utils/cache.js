export class TTLCache {
  constructor(ttlMs, max = 250) { this.ttlMs = ttlMs; this.max = max; this.items = new Map(); }
  get(key) {
    const item = this.items.get(key);
    if (!item) return undefined;
    if (item.expires <= Date.now()) { this.items.delete(key); return undefined; }
    return structuredClone(item.value);
  }
  delete(key) { return this.items.delete(key); }
  clear() { const removed=this.items.size;this.items.clear();return removed; }
  set(key, value, trackKeys = []) {
    for (const [k,v] of this.items) if (v.expires <= Date.now()) this.items.delete(k);
    this.items.delete(key);
    if (this.items.size >= this.max) this.items.delete(this.items.keys().next().value);
    this.items.set(key, { expires: Date.now() + this.ttlMs, value: structuredClone(value), trackKeys: new Set(trackKeys) });
    return value;
  }
  tag(key, trackKeys) {
    const item = this.items.get(key);
    if (!item) return;
    for (const trackKey of trackKeys) item.trackKeys.add(trackKey);
  }
  markPlayed(trackKeys) {
    for (const item of this.items.values()) {
      if (trackKeys.some(key => item.trackKeys.has(key))) item.played = true;
    }
  }
  clearPlayed(protectedKeys) {
    let removed = 0;
    for (const [key, item] of this.items) {
      if (!item.played || [...item.trackKeys].some(trackKey => protectedKeys.has(trackKey))) continue;
      this.items.delete(key);
      removed++;
    }
    return removed;
  }
}

export const CACHE_CLEANUP_INTERVAL_MS = 150_000;

export function startCacheCleanup(cleanup) {
  const timer = setInterval(cleanup, CACHE_CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
