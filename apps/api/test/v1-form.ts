import { V1 } from '@form/schema';

/** A v1 form as an older builder saved it (no schemaVersion), with the settings the import tests care about. */
export function v1Form(
  over: { title?: string; password?: string; closed?: boolean; closedMessage?: string; logoUrl?: string; id?: string } = {},
): V1.FormSchema {
  return {
    id: over.id ?? 'local-v1-id',
    title: over.title ?? 'Event signup',
    description: '',
    blocks: [
      { id: 'b1', type: 'text', label: 'Your name', placeholder: 'Full name', validation: { required: true }, order: 0 },
      { id: 'b2', type: 'email', label: 'Email address', order: 1 },
    ],
    settings: {
      ...V1.DEFAULT_SETTINGS,
      password: over.password ?? '',
      closed: over.closed ?? false,
      ...(over.closedMessage !== undefined ? { closedMessage: over.closedMessage } : {}),
      ...(over.logoUrl !== undefined ? { logoUrl: over.logoUrl } : {}),
    },
  };
}
