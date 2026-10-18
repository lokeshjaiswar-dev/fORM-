import type { AVScanner, ByteStream } from '@form/ports';

async function drain(stream: ByteStream): Promise<void> {
  const it = stream[Symbol.asyncIterator]();
  while (!(await it.next()).done);
}

/** `AV_DRIVER=none`: inspects nothing, so every verdict is `skipped` and publish forces `scan: 'off'`. */
export function createNoopScanner(): AVScanner {
  return {
    async scan(stream) {
      await drain(stream);
      return { verdict: 'skipped', engineVersion: 'none' };
    },
    async health() {
      return { ok: true, engineVersion: 'none' };
    },
  };
}
