import { useState } from 'react';
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
      <label className="fr-captcha-box" htmlFor={id}>
        <input id={id} type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
        <span>{t(MESSAGES['captcha.not_robot'])}</span>
      </label>
    </div>
  );
}
