import { useState } from 'react';
import { defineMessages } from '@form/i18n';
import { Button, Input, Label } from '@dmacq/ui';
import { t } from '@/i18n';

const M = defineMessages('builder', {
  'access.address': 'Public address',
  'access.address_hint': 'Letters, digits and hyphens, 3 to 100 characters. The old address keeps working and sends people to the new one.',
  'access.address_invalid': 'Use 3 to 100 lower-case letters, digits and hyphens, starting and ending with a letter or digit.',
  'access.address_taken': 'That address is already used by another form. Choose a different one.',
  'access.address_change': 'Change address',
  'access.address_current': 'Now at {url}',
  'access.address_unpublished': 'The form has no address until it is published or given one here.',
  'access.address_earlier': 'Earlier addresses that still work: {list}',
});

/** What `PUT .../slug` accepts (the API's own rule), so a typo is answered before the round trip. */
export const SLUG = /^[a-z0-9][a-z0-9-]{1,98}[a-z0-9]$/;

export interface AddressFieldProps {
  slug: string | null;
  previousSlugs: string[];
  busy: boolean;
  /** Whether the address changed: `taken` when another form holds it, else the server's text. */
  onChange: (slug: string) => Promise<{ kind: 'ok' } | { kind: 'taken' } | { kind: 'error'; message: string }>;
  field: string | undefined;
  labelCls: string | undefined;
}

/** The form's public address (PUB-03): the author's own slug, with a taken address answered next to the box. */
export function AddressField({ slug, previousSlugs, busy, onChange, field, labelCls }: AddressFieldProps) {
  const [draft, setDraft] = useState(slug ?? '');
  const [error, setError] = useState<string | null>(null);
  const typed = draft.trim().toLowerCase();
  const unchanged = typed === (slug ?? '');

  const change = async () => {
    if (!SLUG.test(typed)) {
      setError(t(M['access.address_invalid']));
      return;
    }
    setError(null);
    const result = await onChange(typed);
    if (result.kind === 'taken') setError(t(M['access.address_taken']));
    else if (result.kind === 'error') setError(result.message);
    else setDraft(typed);
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor="access-address" className={labelCls}>{t(M['access.address'])}</Label>
      <div className="flex gap-2">
        <Input
          id="access-address"
          className={field}
          value={draft}
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          aria-invalid={error !== null}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
        />
        <Button type="button" size="sm" variant="secondary" disabled={busy || unchanged || typed === ''} onClick={() => void change()}>
          {t(M['access.address_change'])}
        </Button>
      </div>
      {error ? (
        <p className="text-[12px] text-destructive" role="alert">{error}</p>
      ) : (
        <p className="text-[12px] text-muted-foreground">{slug ? t(M['access.address_current'], { url: `${window.location.origin}/f/${slug}` }) : t(M['access.address_unpublished'])}</p>
      )}
      {previousSlugs.length > 0 ? <p className="text-[12px] text-muted-foreground">{t(M['access.address_earlier'], { list: previousSlugs.join(', ') })}</p> : null}
      <p className="text-[12px] text-muted-foreground">{t(M['access.address_hint'])}</p>
    </div>
  );
}
