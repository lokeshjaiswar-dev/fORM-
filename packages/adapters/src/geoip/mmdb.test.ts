import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTestMmdb, expectPortError, runGeoIPContract } from '@form/testkit';
import { createMmdbGeoIP, loadMmdbGeoIP } from './mmdb.ts';

runGeoIPContract('MMDB (DB-IP Lite format)', ({ database }) => ({ impl: createMmdbGeoIP(database) }));

describe('MMDB GeoIP', () => {
  it('loads GEOIP_DB_PATH and names the build', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'form-geoip-'));
    try {
      const file = path.join(dir, 'dbip-country-lite.mmdb');
      await writeFile(file, buildTestMmdb([{ network: '1.6.0.0/15', country: 'IN' }], { buildEpochSec: 1_791_000_000 }));
      const geo = await loadMmdbGeoIP(file);
      expect(geo.databaseVersion).toBe(`DBIP-Country-Lite@${new Date(1_791_000_000_000).toISOString()}`);
      expect(geo.country('1.6.1.1')).toBe('IN');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a file that is not an MMDB database', async () => {
    await expectPortError(Promise.resolve().then(() => createMmdbGeoIP(new TextEncoder().encode('not a database'))), 'invalid_argument');
  });
});
