import { useId, useState } from 'react';
import type { MessageId } from '@form/i18n';
import type { RuntimeStatus } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { RichTextView } from '../richtext/RichTextView.tsx';
import type { RendererEvent } from '../types.ts';

const TITLES: Readonly<Record<Exclude<RuntimeStatus['state'], 'open'>, MessageId>> = {
  closed: 'system:form.closed',
  not_yet_open: 'system:form.not_open_yet',
  outside_hours: 'system:form.not_open_yet',
  limit_reached: 'system:form.limit_reached',
  password: 'system:form.password_prompt',
  already_submitted: 'system:form.already_submitted',
};

/**
 * A form that is not open: the author's screen when it has one, the system message otherwise. A password status asks
 * for the password and hands it to `onUnlock` (no event carries it); the host checks it and changes the status.
 */
export function StatusScreen({ status, onEvent, onUnlock }: {
  status: Exclude<RuntimeStatus, { state: 'open' }>;
  onEvent: ((event: RendererEvent) => void) | undefined;
  onUnlock: ((password: string) => void) | undefined;
}) {
  const { t } = useRenderer();
  const [password, setPassword] = useState('');
  const inputId = useId();
  const custom = status.screen.content.length > 0;
  const single = custom && status.screen.content.length === 1 && status.screen.content[0]?.type === 'paragraph';
  return (
    <div className="fr-screen fr-status" data-state={status.state}>
      {single ? (
        <h2 className="fr-screen-title"><RichTextView doc={status.screen} inline /></h2>
      ) : (
        <>
          <h2 className="fr-screen-title">{t(TITLES[status.state])}</h2>
          {custom ? <div className="fr-rich"><RichTextView doc={status.screen} /></div> : null}
        </>
      )}
      {status.state === 'password' ? (
        <form
          className="fr-password"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            onEvent?.({ type: 'unlock' });
            onUnlock?.(password);
          }}
        >
          <label className="fr-label" htmlFor={inputId}>{t(MESSAGES['password.label'])}</label>
          <input id={inputId} className="fr-input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button type="submit" className="fr-button fr-primary">{t(MESSAGES['password.submit'])}</button>
        </form>
      ) : null}
    </div>
  );
}
