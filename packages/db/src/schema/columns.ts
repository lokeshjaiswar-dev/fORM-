import { customType, timestamp } from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength),
  fromDriver: (v) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
});

export const ts = (name: string) => timestamp(name, { withTimezone: true }).notNull().defaultNow();
export const tsNull = (name: string) => timestamp(name, { withTimezone: true });

/** `org_key` of platform-level audit events. */
export const PLATFORM_ORG_KEY = '00000000-0000-0000-0000-000000000000';
