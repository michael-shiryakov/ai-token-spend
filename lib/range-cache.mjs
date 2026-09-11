// sessionStorage-backed cache so that once a range's data has been fetched (either by
// viewing it or by the background prefetch in index.html), switching back to it is instant
// instead of re-hitting the network. Keyed by endpoint + range so every preset period
// caches independently. Scoped to the tab session on purpose — finance figures can
// change intraday, and a hard reload/new tab should always see fresh numbers.
export const CACHE_PREFIX = "atsCache:v1:";

export function readRangeCache(endpoint, key) {
  try {
    const raw = sessionStorage.getItem(`${CACHE_PREFIX}${endpoint}:${key}`);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

export function writeRangeCache(endpoint, key, data) {
  try {
    sessionStorage.setItem(
      `${CACHE_PREFIX}${endpoint}:${key}`,
      JSON.stringify(data),
    );
  } catch {
    // sessionStorage full/unavailable — caching is a speed optimization, not required
  }
}
