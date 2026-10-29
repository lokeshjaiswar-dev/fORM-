import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { Reader, type CountryResponse } from 'mmdb-lib';
import { PortError, type CountryCode, type GeoIP } from '@form/ports';

const ISO2 = /^[A-Z]{2}$/;

/** `::ffff:a.b.c.d` is looked up as the IPv4 address it carries; databases do not all alias that range. */
function canonicalIp(ip: string): string | undefined {
  const trimmed = ip.trim().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  const v = mapped ? mapped[1]! : trimmed;
  return isIP(v) === 0 ? undefined : v;
}

/**
 * Offline country lookup from an MMDB file (architecture §6: DB-IP Lite; SaaS refreshes it weekly with `geoip.refresh`,
 * on-prem and air-gapped installs get it in the bundle). Nothing leaves the process. Junk and unknown addresses are
 * `undefined`, never an error, because the answer only feeds rate limits and analytics.
 */
export function createMmdbGeoIP(database: Uint8Array): GeoIP {
  let reader: Reader<CountryResponse>;
  try {
    reader = new Reader<CountryResponse>(Buffer.from(database));
  } catch (e) {
    throw new PortError('invalid_argument', `not an MMDB database: ${(e as Error).message}`, { cause: e });
  }
  const m = reader.metadata;
  const databaseVersion = `${m.databaseType}@${m.buildEpoch.toISOString()}`;
  return {
    databaseVersion,
    country(ip) {
      const v = canonicalIp(ip);
      if (!v) return undefined;
      let record: CountryResponse | null;
      try {
        record = reader.get(v);
      } catch {
        return undefined;
      }
      const code = record?.country?.iso_code ?? record?.registered_country?.iso_code;
      return typeof code === 'string' && ISO2.test(code) ? (code as CountryCode) : undefined;
    },
  };
}

/** `GEOIP_DB_PATH`, read once at boot. */
export async function loadMmdbGeoIP(path: string): Promise<GeoIP> {
  return createMmdbGeoIP(await readFile(path));
}
