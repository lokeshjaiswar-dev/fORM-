import type { FormDefinition, IsoInstant } from '@form/schema';
import type { Opened } from '@/persistence/openForm';
import { parseFormJson, serializeForm } from '@/lib/formJson';

/*
 * Preview links: the whole form travels in the link itself, gzip-compressed and base64url-encoded after `#form=`. The
 * part after `#` never reaches a server, so the link works with no API or database, and opening it stores nothing.
 * Anyone who can reach this builder (on this network) sees a read-only copy of the form as it was when the link was
 * made; answers are not saved.
 */

const PREFIX = '#form=';
/** Links far longer than any real form are refused before decoding (they may be crafted to exhaust memory). */
const MAX_LINK_CHARS = 400_000;
const MAX_JSON_BYTES = 2_000_000;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const body = new Response(bytes as BodyInit).body;
  if (!body) throw new Error('no body');
  const out = new Response(body.pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** The `#form=…` fragment carrying `doc`. */
export async function encodeShareFragment(doc: FormDefinition): Promise<string> {
  const json = new TextEncoder().encode(serializeForm(doc));
  return `${PREFIX}${toBase64Url(await pipe(json, new CompressionStream('gzip')))}`;
}

/**
 * Reads a form out of a preview link's fragment. The form is checked against the strict schema exactly as an imported
 * file is, so a damaged or hand-made link is refused with a reason and never half-shown. Never throws.
 */
export async function decodeShareFragment(hash: string, now: IsoInstant): Promise<Opened> {
  if (!hash.startsWith(PREFIX)) return { ok: false, error: 'This link does not contain a form.' };
  if (hash.length > MAX_LINK_CHARS) return { ok: false, error: 'This link is too long to open.' };
  try {
    const bytes = await pipe(fromBase64Url(hash.slice(PREFIX.length)), new DecompressionStream('gzip'));
    if (bytes.length > MAX_JSON_BYTES) return { ok: false, error: 'This link is too long to open.' };
    return parseFormJson(new TextDecoder().decode(bytes), 'shared-preview', now);
  } catch {
    return { ok: false, error: 'This link is damaged. Ask for a new one.' };
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * The address to put in a preview link. A builder opened on this computer (localhost) gives a link only this computer
 * can open, so the dev server's network address is used instead when it is known; any other address is kept as it is.
 */
export function shareOrigin(location: Pick<Location, 'protocol' | 'hostname' | 'port' | 'origin'>, networkAddresses: readonly string[]): string {
  if (!LOOPBACK.has(location.hostname) || networkAddresses.length === 0) return location.origin;
  return `${location.protocol}//${networkAddresses[0]}${location.port ? `:${location.port}` : ''}`;
}

/** This computer's network addresses, filled in by the dev server (empty in a production build). */
export const NETWORK_ADDRESSES: readonly string[] = (import.meta.env.VITE_NETWORK_ADDRESSES as string | undefined)?.split(',').filter(Boolean) ?? [];

export async function previewLink(doc: FormDefinition): Promise<string> {
  return `${shareOrigin(window.location, NETWORK_ADDRESSES)}/share${await encodeShareFragment(doc)}`;
}
