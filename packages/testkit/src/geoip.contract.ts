import { describe, expect, it } from 'vitest';
import type { GeoIP } from '@form/ports';
import { useSubject, type ContractSubject } from './contract.ts';
import { buildTestMmdb, type MmdbNetwork } from './mmdb-writer.ts';

/** The networks of the fixture database, in DB-IP's shape. */
export const GEOIP_FIXTURE_NETWORKS: readonly MmdbNetwork[] = [
  { network: '1.6.0.0/15', country: 'IN' },
  { network: '8.8.8.0/24', country: 'US' },
  { network: '81.2.69.0/24', country: 'GB' },
  { network: '2405:200::/29', country: 'IN' },
  { network: '2001:4860::/32', country: 'US' },
];

export interface GeoIPFixture {
  networks: readonly MmdbNetwork[];
  /** The fixture as an MMDB file. */
  database: Uint8Array;
}

/** The setup builds the implementation over the fixture database (or loads the same networks some other way). */
export function runGeoIPContract(label: string, setup: (fixture: GeoIPFixture) => ContractSubject<GeoIP> | Promise<ContractSubject<GeoIP>>): void {
  describe(`GeoIP contract: ${label}`, () => {
    const subject = useSubject(() => setup({ networks: GEOIP_FIXTURE_NETWORKS, database: buildTestMmdb(GEOIP_FIXTURE_NETWORKS) }));
    const geo = () => subject().impl;

    it('names its database version', () => {
      expect(geo().databaseVersion.length).toBeGreaterThan(0);
    });

    it.each([
      ['1.6.0.1', 'IN'],
      ['1.7.255.254', 'IN'],
      ['8.8.8.8', 'US'],
      ['81.2.69.160', 'GB'],
      ['2405:201:abcd::1', 'IN'],
      ['2001:4860:4860::8888', 'US'],
      ['::ffff:8.8.8.8', 'US'],
      ['[2001:4860::1]', 'US'],
    ])('places %s in %s', (ip, country) => {
      expect(geo().country(ip)).toBe(country);
    });

    it.each(['1.8.0.1', '8.8.9.9', '9.9.9.9', '2a00:1450::1', '10.0.0.1', '127.0.0.1', '192.168.1.1', '::1', 'fe80::1'])('knows no country for %s', (ip) => {
      expect(geo().country(ip)).toBeUndefined();
    });

    it.each(['', ' ', 'not-an-ip', '999.1.1.1', '1.2.3', '1.6.0.1/24', '1.6.0.1:443', 'localhost', '::ffff:999.0.0.1'])('answers undefined for junk %j, without throwing', (ip) => {
      expect(geo().country(ip)).toBeUndefined();
    });
  });
}
