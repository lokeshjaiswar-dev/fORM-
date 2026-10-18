import type { CountryCode } from './common.ts';

/** Offline lookup (DB-IP Lite); air-gapped installs get the database in the bundle. */
export interface GeoIP {
  readonly databaseVersion: string;
  country(ip: string): CountryCode | undefined;
}
