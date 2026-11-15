import { useState } from 'react';
import { Check } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { Button, Input, Label } from '@dmacq/ui';
import { t } from '@/i18n';

const M = defineMessages('builder', {
  'access.password': 'Password',
  'access.password_new': 'New password',
  'access.password_hint': 'Respondents enter it before they see the form. It is stored hashed on the server and cannot be shown again.',
  'access.password_set': 'Password set',
  'access.password_none': 'No password',
  'access.password_set_button': 'Set password',
  'access.password_change_button': 'Change password',
  'access.password_remove': 'Remove password',
});

/** What a respondent password's controls need: whether one is set, and calls that answer null when it worked or the text to show when it did not. */
export interface PasswordFieldProps {
  hasPassword: boolean;
  busy: boolean;
  onSet: (password: string) => Promise<string | null>;
  onRemove: () => Promise<string | null>;
  field: string | undefined;
  labelCls: string | undefined;
}

/**
 * The respondent password (ACC-05). It is sent once and the server keeps only a hash, so this shows "Password set" and
 * never a value: the box is emptied as soon as the server has the password, and nothing here reads one back.
 */
export function PasswordField({ hasPassword, busy, onSet, onRemove, field, labelCls }: PasswordFieldProps) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const set = async () => {
    setError(null);
    const problem = await onSet(draft);
    if (problem === null) setDraft('');
    else setError(problem);
  };
  const remove = async () => {
    setError(null);
    const problem = await onRemove();
    if (problem !== null) setError(problem);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="access-password" className={labelCls}>{t(M['access.password'])}</Label>
        <span className="flex items-center gap-1 text-[12px] text-muted-foreground" role="status">
          {hasPassword ? <Check className="size-3.5" aria-hidden /> : null}
          {t(hasPassword ? M['access.password_set'] : M['access.password_none'])}
        </span>
      </div>
      <div className="flex gap-2">
        <Input
          id="access-password"
          type="password"
          autoComplete="new-password"
          className={field}
          value={draft}
          placeholder={hasPassword ? t(M['access.password_new']) : ''}
          maxLength={512}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="button" size="sm" variant="secondary" disabled={busy || draft === ''} onClick={() => void set()}>
          {t(hasPassword ? M['access.password_change_button'] : M['access.password_set_button'])}
        </Button>
      </div>
      {hasPassword ? (
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void remove()}>
          {t(M['access.password_remove'])}
        </Button>
      ) : null}
      <p className="text-[12px] text-muted-foreground">{t(M['access.password_hint'])}</p>
      {error ? <p className="text-[12px] text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}
