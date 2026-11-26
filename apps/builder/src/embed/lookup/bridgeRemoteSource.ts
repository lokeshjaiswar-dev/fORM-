import type { RemoteSource } from '@form/renderer';
import type { UploadController } from '@/embed/upload/controller';

/** The upload iframe's source: lookups go to the DMS parent over fp-bridge/2 (`lookup.request`, answered by the parent as the user). It offers no option list and no check: DMS forms have neither. */
export function bridgeRemoteSource(controller: () => Pick<UploadController, 'lookup'> | null): RemoteSource {
  return {
    async lookup(lookupId, q, signal) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      const result = (await controller()?.lookup(lookupId, q)) ?? { rows: [], truncated: false };
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      return result;
    },
  };
}
