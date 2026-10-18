import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { tables } from './client.ts';
import { PII_COVERAGE } from './pii.ts';

describe('PII coverage manifest', () => {
  const configs = Object.values(tables).map((t) => getTableConfig(t));

  it('has an entry for every table and no others', () => {
    expect(Object.keys(PII_COVERAGE).sort()).toEqual(configs.map((c) => c.name).sort());
  });

  it('names real columns only', () => {
    for (const c of configs) {
      const names = new Set(c.columns.map((col) => col.name));
      for (const col of PII_COVERAGE[c.name as keyof typeof PII_COVERAGE].columns) expect(names.has(col), `${c.name}.${col}`).toBe(true);
    }
  });
});
