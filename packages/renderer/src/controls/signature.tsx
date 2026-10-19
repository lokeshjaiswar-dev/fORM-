import { useRef, useState } from 'react';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { RichTextView } from '../richtext/RichTextView.tsx';
import { SignaturePad } from '../signature/SignaturePad.tsx';
import { cssColor } from '../theme/cssVars.ts';
import { useAnswer, type ControlProps } from './hooks.ts';

/** The typed name drawn as a PNG, so a typed signature has an image like a drawn one. */
function typedPng(name: string, color: string): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.fillStyle = color.startsWith('var(') ? '#111111' : color;
  ctx.font = 'italic 48px "Segoe Script", "Brush Script MT", cursive';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 24, 80, 592);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/**
 * FLD-28: draw, or type a name (the accessible alternative). Each signature is uploaded as a PNG through `uploader`
 * (S10: the answer is a file reference, never a data URL); an older upload that finishes late is ignored.
 */
export function Signature({ block, field }: ControlProps<'signature'>) {
  const { t, uploader, track } = useRenderer();
  const answer = useAnswer(block);
  const c = block.config;
  const [mode, setMode] = useState<'draw' | 'type'>(answer.value?.method === 'typed' ? 'type' : 'draw');
  const [typed, setTyped] = useState(answer.value?.typedName ?? '');
  const [status, setStatus] = useState<'idle' | 'saving' | 'failed'>('idle');
  const latest = useRef(0);
  const pen = cssColor(c.penColor) ?? 'var(--fr-text)';
  const locked = field.disabled || field.readOnly;
  const committed = useRef<string | null>(answer.value?.method === 'typed' ? answer.value.typedName : null);

  const clear = () => {
    latest.current += 1;
    committed.current = null;
    answer.set(undefined);
    setStatus('idle');
  };

  /* Tracked at once, before the PNG is encoded, so Next and Submit wait for the encoding and the upload. */
  const save = (png: Promise<Blob | null>, typedName?: string) => {
    const run = (latest.current += 1);
    setStatus('saving');
    const upload = async () => {
      const blob = await png;
      if (run !== latest.current) return;
      if (!blob) return clear();
      try {
        const file = await uploader({ blockId: block.id, purpose: 'signature', file: blob, name: 'signature.png' });
        if (run !== latest.current) return;
        setStatus('idle');
        answer.set(typedName === undefined ? { method: 'drawn', file } : { method: 'typed', file, typedName });
      } catch {
        if (run !== latest.current) return;
        committed.current = null;
        setStatus('failed');
      }
    };
    void track(upload());
  };

  /* The typed name is committed on blur and on Enter (which submits the form before any blur). */
  const commitTyped = () => {
    const name = typed.trim();
    if (!name) return clear();
    if (committed.current === name) return;
    committed.current = name;
    save(typedPng(name, pen), name);
  };

  const statementId = `${field.ids.base}-statement`;
  const describedBy = [field.ids.describedBy, c.statement ? statementId : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <div className="fr-signature-field">
      {c.statement ? (
        <p id={statementId} className="fr-statement"><RichTextView doc={c.statement} inline /></p>
      ) : null}
      {mode === 'draw' ? (
        <SignaturePad
          id={field.ids.input}
          disabled={locked}
          penColor={pen}
          heightPx={c.heightPx}
          label={t(MESSAGES['signature.pad'])}
          clearLabel={t('system:signature.clear')}
          describedBy={describedBy}
          onChange={(png) => (png ? save(png) : clear())}
        />
      ) : (
        <div className="fr-typed-signature">
          <label className="fr-sublabel" htmlFor={field.ids.input}>{t(MESSAGES['signature.typed_label'])}</label>
          <input
            id={field.ids.input}
            className="fr-input fr-typed-name"
            type="text"
            autoComplete="name"
            value={typed}
            disabled={field.disabled}
            readOnly={field.readOnly || undefined}
            aria-describedby={describedBy}
            aria-invalid={field.invalid || undefined}
            onChange={(e) => {
              setTyped(e.target.value);
              latest.current += 1;
              committed.current = null;
              if (answer.value) answer.set(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTyped();
            }}
            onBlur={() => {
              answer.onBlur();
              commitTyped();
            }}
          />
        </div>
      )}
      {c.allowTyped && !locked ? (
        <button
          type="button"
          className="fr-link-button"
          onClick={() => {
            setMode(mode === 'draw' ? 'type' : 'draw');
            clear();
          }}
        >
          {t(mode === 'draw' ? MESSAGES['signature.type_instead'] : MESSAGES['signature.draw_instead'])}
        </button>
      ) : null}
      {status === 'idle' ? null : (
        <p className="fr-hint" role="status">{t(status === 'saving' ? MESSAGES['signature.uploading'] : MESSAGES['signature.failed'])}</p>
      )}
    </div>
  );
}
