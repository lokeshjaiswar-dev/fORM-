import { useState } from 'react';
import { CheckboxField } from '@dmacq/ui';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import type { ControlProps } from './hooks.ts';

/** Visual spam check; platform_default is a local tick until the hosted challenge lands. */
export function Captcha({ block }: ControlProps<'captcha'>) {
  const { t } = useRenderer();
  const [ok, setOk] = useState(false);
  const id = `fr-captcha-${block.id}`;
  return (
    <div className="fr-captcha">
      <CheckboxField id={id} className="fr-captcha-box" checked={ok} onCheckedChange={(on) => setOk(on === true)} label={t(MESSAGES['captcha.not_robot'])} />
    </div>
  );
}
