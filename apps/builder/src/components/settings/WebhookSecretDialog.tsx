import { TriangleAlert } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { Alert, AlertDescription, Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, TextLink } from '@dmacq/ui';
import { t } from '@/i18n';
import { CopyLink } from '@/components/CopyLink';
import { W, WEBHOOK_SIGNATURE_DOC_URL } from '@/components/settings/webhookText';

const M = defineMessages('builder', {
  'webhooks.secret.title_created': 'Copy the signing secret now',
  'webhooks.secret.title_rotated': 'Copy the new signing secret now',
  'webhooks.secret.description_created': 'Your receiver uses this secret to check that a request really came from fORM-.',
  'webhooks.secret.description_rotated': 'The old secret stopped working the moment you replaced it. Put this one in your receiver.',
  'webhooks.secret.warning': 'This is the only time the secret is shown. It is kept sealed and cannot be shown again; if you lose it, replace it with a new one.',
  'webhooks.secret.field': 'Signing secret',
  'webhooks.secret.copy': 'Copy secret',
  'webhooks.secret.for': 'For the webhook at {host}',
  'webhooks.secret.done': 'I have saved it',
});

/** A signing secret just issued, and what it is for. It lives only as long as the dialog that shows it. */
export interface IssuedSecretNotice {
  secret: string;
  kind: 'created' | 'rotated';
  /** The host of the webhook's address: enough to tell which webhook it is for, with no path or query that may carry a token. */
  host: string;
}

/**
 * The one-time secret of a webhook (WP-1.18), shown after it is made and after it is replaced. The secret is a prop, so the
 * caller decides how long it lives: the Webhooks tab holds it in one piece of state and clears that on close, and this dialog
 * is not rendered at all while there is none, so nothing of the secret is left behind once it is closed. A click outside does
 * not close it (the secret would be lost by accident); Escape, the close button and the button below do.
 */
export function WebhookSecretDialog({ issued, onClose }: { issued: IssuedSecretNotice | null; onClose: () => void }) {
  if (!issued) return null;
  const created = issued.kind === 'created';
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t(created ? M['webhooks.secret.title_created'] : M['webhooks.secret.title_rotated'])}</DialogTitle>
          <DialogDescription>{t(created ? M['webhooks.secret.description_created'] : M['webhooks.secret.description_rotated'])}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Alert variant="warning" icon={<TriangleAlert className="size-4" />}>
            <AlertDescription>{t(M['webhooks.secret.warning'])}</AlertDescription>
          </Alert>
          <div>
            <p className="mb-1.5 text-[13px] text-muted-foreground">{t(M['webhooks.secret.for'], { host: issued.host })}</p>
            <CopyLink link={issued.secret} label={t(M['webhooks.secret.field'])} copyLabel={t(M['webhooks.secret.copy'])} />
          </div>
          <p className="text-[13px]">
            <TextLink href={WEBHOOK_SIGNATURE_DOC_URL} target="_blank" rel="noopener noreferrer" size="small">
              {t(W['webhooks.signature_doc'])}
            </TextLink>
          </p>
        </div>
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t(M['webhooks.secret.done'])}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
