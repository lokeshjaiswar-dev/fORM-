/** FNV-1a over UTF-16 code units: a 32-bit seed from a string. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small, fast, deterministic. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * PROP-11: the same seed gives the same order on the server, on hydration and after Back. The last `keepLast`
 * items stay where they are.
 */
export function seededShuffle<T>(items: readonly T[], seed: string, keepLast = 0): T[] {
  const pinned = Math.min(Math.max(0, keepLast), items.length);
  const head = items.slice(0, items.length - pinned);
  const next = random(hash(seed));
  for (let i = head.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [head[i], head[j]] = [head[j] as T, head[i] as T];
  }
  return [...head, ...items.slice(items.length - pinned)];
}
