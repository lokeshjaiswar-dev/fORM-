import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * A random v4 UUID. `crypto.randomUUID` exists only in secure contexts (https, localhost), so a builder served over
 * plain http on a LAN host builds one from `getRandomValues`, which works everywhere (BL-140).
 */
export function uid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function' && globalThis.isSecureContext !== false) return c.randomUUID();
  const bytes = c.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
