import { describe, expect, it } from 'vitest';
import { WeightedCache } from './weighted-cache.ts';

describe('WeightedCache', () => {
  it('evicts the least recently used entries until the new one fits the weight budget', () => {
    const cache = new WeightedCache<string>(100, 10);
    cache.set('a', 'A', 4);
    cache.set('b', 'B', 4);
    cache.get('a');
    cache.set('c', 'C', 4);
    expect([cache.get('a'), cache.get('b'), cache.get('c')]).toEqual(['A', undefined, 'C']);
    expect(cache.weight).toBe(8);
    cache.set('d', 'D', 9);
    expect([cache.get('a'), cache.get('c'), cache.get('d')]).toEqual([undefined, undefined, 'D']);
    expect(cache.weight).toBe(9);
  });

  it('is bounded by the number of entries too', () => {
    const cache = new WeightedCache<number>(2, 1000);
    cache.set('a', 1, 1);
    cache.set('b', 2, 1);
    cache.set('c', 3, 1);
    expect([cache.get('a'), cache.get('b'), cache.get('c')]).toEqual([undefined, 2, 3]);
    expect(cache.size).toBe(2);
  });

  it('does not keep an entry heavier than the whole budget, and replaces an entry in place', () => {
    const cache = new WeightedCache<string>(10, 10);
    cache.set('big', 'x', 11);
    expect(cache.get('big')).toBeUndefined();
    expect(cache.weight).toBe(0);
    cache.set('a', 'old', 6);
    cache.set('a', 'new', 3);
    expect([cache.get('a'), cache.weight, cache.size]).toEqual(['new', 3, 1]);
    cache.set('a', 'huge', 99);
    expect([cache.get('a'), cache.weight, cache.size]).toEqual([undefined, 0, 0]);
  });
});
