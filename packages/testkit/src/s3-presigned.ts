import { PortError } from '@form/ports';
import type { PresignedClient } from './storage.contract.ts';

const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1] ?? '';

/** An S3 error document as the PortError the storage contract expects; anything unrecognised stays a plain Error. */
function s3Refusal(status: number, xml: string): Error {
  const code = tag(xml, 'Code');
  const message = tag(xml, 'Message');
  const text = `${status} ${code}: ${message}`;
  if (code === 'SignatureDoesNotMatch' || code === 'InvalidAccessKeyId') return new PortError('integrity', text);
  if (/expired/i.test(message) || code === 'ExpiredToken' || code === 'RequestExpired') return new PortError('expired', text);
  if (['EntityTooLarge', 'EntityTooSmall', 'InvalidArgument', 'MalformedPOSTRequest', 'InvalidPolicyDocument'].includes(code)) return new PortError('invalid_argument', text);
  if (code === 'AccessDenied' && /polic|condition/i.test(message)) return new PortError('invalid_argument', text);
  return new Error(`unexpected S3 answer ${text}`);
}

/** What a browser does with an S3 presigned POST and GET, for the storage contract against a real S3 API. */
export function s3PresignedClient(): PresignedClient {
  return {
    async upload(post, body, contentType) {
      // S3 stores the Content-Type form field, not the file part's type: the uploader's claim goes there.
      const form = new FormData();
      for (const [k, v] of Object.entries({ ...post.fields, 'Content-Type': contentType })) form.append(k, v);
      form.append('file', new Blob([Buffer.from(body)], { type: contentType }), 'upload.bin');
      const res = await fetch(post.url, { method: 'POST', body: form });
      if (res.status >= 200 && res.status < 300) return;
      throw s3Refusal(res.status, await res.text());
    },
    async download(url) {
      const res = await fetch(url);
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
      throw s3Refusal(res.status, await res.text());
    },
  };
}
