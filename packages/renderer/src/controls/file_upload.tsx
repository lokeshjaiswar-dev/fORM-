import { useRef, useState } from 'react';
import { useFormContext } from 'react-hook-form';
import { acceptsFile } from '@form/registry';
import type { AnswerValue, FileRef } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

interface Pending { key: number; name: string; error?: string }

const MIB = 1024 * 1024;
const size = (bytes: number) => (bytes >= MIB ? `${Math.round((bytes / MIB) * 10) / 10} MB` : `${Math.ceil(bytes / 1024)} KB`);

/**
 * FLD-26/27: files go to `uploader` as soon as they are picked (S10: the answer holds only references). A file of the
 * wrong type or size is refused here before it is sent; validation checks the references again.
 */
export function FileUpload({ block, field }: ControlProps<'file_upload'>) {
  const { t, uploader, track } = useRenderer();
  const { getValues } = useFormContext();
  const answer = useAnswer(block);
  const c = block.config;
  const files = answer.value ?? [];
  const [pending, setPending] = useState<Pending[]>([]);
  const next = useRef(0);
  const current = (): FileRef[] => {
    const raw = getValues(block.id) as AnswerValue | null | undefined;
    return raw?.type === 'file_upload' ? raw.value : [];
  };
  const types = [...c.accept.extensions].join(', ');

  const add = (picked: FileList | null) => {
    const room = Math.max(0, c.maxFiles - files.length - pending.filter((p) => !p.error).length);
    for (const file of Array.from(picked ?? []).slice(0, room)) {
      const key = (next.current += 1);
      const problem = !acceptsFile({ name: file.name, mime: file.type }, c.accept)
        ? t('system:file_type_not_allowed', { types })
        : file.size > c.maxFileBytes ? t('system:file_too_large', { max: size(c.maxFileBytes) }) : undefined;
      if (problem) {
        setPending((list) => [...list, { key, name: file.name, error: problem }]);
        continue;
      }
      setPending((list) => [...list, { key, name: file.name }]);
      void track(uploader({ blockId: block.id, purpose: 'file', file, name: file.name })).then(
        (ref) => {
          setPending((list) => list.filter((p) => p.key !== key));
          answer.set([...current(), ref]);
        },
        () => setPending((list) => list.map((p) => (p.key === key ? { ...p, error: t(MESSAGES['file.failed'], { name: file.name }) } : p))),
      );
    }
  };
  const remove = (fileId: string) => {
    const kept = current().filter((f) => f.fileId !== fileId);
    answer.set(kept.length ? kept : undefined);
  };
  const extensions = c.accept.extensions.map((e) => `.${e.replace(/^\./, '')}`);
  const locked = field.disabled || field.readOnly;
  return (
    <div className="fr-files">
      <input
        id={field.ids.input}
        className="fr-file-input"
        type="file"
        multiple={c.maxFiles > 1}
        accept={[...extensions, ...c.accept.mimeTypes].join(',') || undefined}
        capture={c.capture === 'none' ? undefined : c.capture}
        onChange={(e) => {
          add(e.target.files);
          e.target.value = '';
        }}
        onBlur={answer.onBlur}
        {...inputAttrs(field)}
        readOnly={undefined}
        disabled={locked || files.length >= c.maxFiles}
      />
      {files.length || pending.length ? (
        <ul className="fr-file-list" aria-live="polite">
          {files.map((f) => (
            <li key={f.fileId} className="fr-file">
              <span>{t(MESSAGES['file.uploaded'], { name: f.name })}</span>
              {locked ? null : (
                <button type="button" className="fr-link-button" onClick={() => remove(f.fileId)}>
                  {t(MESSAGES['file.remove'], { name: f.name })}
                </button>
              )}
            </li>
          ))}
          {pending.map((p) => (
            <li key={p.key} className="fr-file" data-error={p.error ? '' : undefined}>
              <span>{p.error ?? t(MESSAGES['file.uploading'], { name: p.name })}</span>
              {p.error ? (
                <button type="button" className="fr-link-button" onClick={() => setPending((list) => list.filter((x) => x.key !== p.key))}>
                  {t(MESSAGES['file.remove'], { name: p.name })}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
