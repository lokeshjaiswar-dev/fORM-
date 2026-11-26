import { useRef, useState } from 'react';
import { Chip } from '@dmacq/ui';
import { useFormContext } from 'react-hook-form';
import { acceptsFile } from '@form/registry';
import type { AnswerValue, FileRef } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { FileDropzone } from './ds.tsx';
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

  const take = (picked: File[]) => {
    const room = Math.max(0, c.maxFiles - files.length - pending.filter((p) => !p.error).length);
    for (const file of picked.slice(0, room)) {
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
  const attrs = inputAttrs(field);
  return (
    <div className="fr-files">
      <FileDropzone
        id={field.ids.input}
        accept={[...extensions, ...c.accept.mimeTypes]}
        maxSize={c.maxFileBytes}
        maxFiles={c.maxFiles}
        currentCount={files.length}
        multiple={c.maxFiles > 1}
        disabled={locked || files.length >= c.maxFiles}
        aria-invalid={attrs['aria-invalid']}
        aria-describedby={attrs['aria-describedby']}
        /* The question names the zone, as it names every other control; the zone's own text stays its description. */
        aria-labelledby={field.ids.label}
        onFilesAdded={(accepted) => take(accepted)}
        size="compact"
      />
      {files.length || pending.length ? (
        <ul className="fr-file-list" aria-live="polite">
          {files.map((f) => (
            <li key={f.fileId} className="fr-file">
              <Chip kind="input" size="sm" {...(locked ? {} : { onRemove: () => remove(f.fileId) })} removeLabel={t(MESSAGES['file.remove'], { name: f.name })}>
                {f.name}
              </Chip>
            </li>
          ))}
          {pending.map((p) => (
            <li key={p.key} className="fr-file" data-error={p.error ? '' : undefined}>
              <Chip
                kind="input"
                size="sm"
                color={p.error ? 'negative' : 'neutral'}
                {...(p.error ? { onRemove: () => setPending((list) => list.filter((x) => x.key !== p.key)) } : {})}
                removeLabel={t(MESSAGES['file.remove'], { name: p.name })}
              >
                {p.error ?? t(MESSAGES['file.uploading'], { name: p.name })}
              </Chip>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
