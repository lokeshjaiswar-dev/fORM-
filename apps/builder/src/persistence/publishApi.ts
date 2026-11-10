import { z } from 'zod';
import { orgApi } from '@/auth/client';

const liveSchema = z.object({
  slug: z.string(),
  versionId: z.string(),
  number: z.number(),
});

export type LiveForm = z.infer<typeof liveSchema>;

export function getLiveForm(id: string): Promise<LiveForm> {
  return orgApi('GET', `/v1/forms/${id}/live`, liveSchema);
}

export function publishForm(id: string): Promise<LiveForm> {
  return orgApi('POST', `/v1/forms/${id}/publish`, liveSchema, {});
}

export function fillUrl(slug: string): string {
  return `${window.location.origin}/f/${encodeURIComponent(slug)}`;
}
