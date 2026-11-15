import { useRef, useState, type DragEvent } from 'react';
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

  const take = (picked: FileList | null) => {
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
  const full = files.length >= c.maxFiles;
  const many = c.maxFiles > 1;
  const hintId = `${field.ids.base}-hint`;
  /* The shown type list is built here from the config, so it is the same text on the server and in the browser. */
  const shownTypes = c.accept.extensions.map((e) => e.replace(/^\./, '').toUpperCase()).join(', ');
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const endDrag = () => {
    depth.current = 0;
    setDragging(false);
  };
  /* The real file input fills the whole zone (invisible), so a click, a keyboard press and a drop all reach the
   * platform's own handling. These handlers only draw the "drop here" state. */
  const onDragEnter = (e: DragEvent) => {
    if (locked || full || !e.dataTransfer.types.includes('Files')) return;
    depth.current += 1;
    setDragging(true);
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  return (
    <div className="fr-files">
      <div
        className="fr-dropzone"
        data-dragging={dragging ? '' : undefined}
        data-disabled={locked || full ? '' : undefined}
        data-invalid={field.invalid ? '' : undefined}
        onDragEnter={onDragEnter}
        onDragLeave={onDragLeave}
        onDrop={endDrag}
      >
        <input
          id={field.ids.input}
          className="fr-dropzone-input"
          type="file"
          multiple={many}
          accept={[...extensions, ...c.accept.mimeTypes].join(',') || undefined}
          capture={c.capture === 'none' ? undefined : c.capture}
          title={t(many ? MESSAGES['file.drop_many'] : MESSAGES['file.drop'])}
          onChange={(e) => {
            take(e.target.files);
            e.target.value = '';
          }}
          onBlur={answer.onBlur}
          {...inputAttrs(field)}
          aria-describedby={[hintId, field.ids.describedBy].filter(Boolean).join(' ')}
          readOnly={undefined}
          disabled={locked || full}
        />
        <span className="fr-dropzone-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false"><path d="M12 16V5m0 0l-4 4m4-4l4 4M5 15v3a1 1 0 001 1h12a1 1 0 001-1v-3" /></svg>
        </span>
        <span className="fr-dropzone-text">
          <span className="fr-dropzone-title" aria-hidden="true">
            <span className="fr-dropzone-drop">{t(many ? MESSAGES['file.drop_many'] : MESSAGES['file.drop'])}</span>
            <span className="fr-dropzone-tap">{t(many ? MESSAGES['file.tap_many'] : MESSAGES['file.tap'])}</span>
          </span>
          <span id={hintId} className="fr-dropzone-hint">
            {shownTypes ? <span>{t(MESSAGES['file.accepted'], { types: shownTypes })}</span> : null}
            <span>{t(many ? MESSAGES['file.size_limit_each'] : MESSAGES['file.size_limit'], { size: size(c.maxFileBytes) })}</span>
            {many ? <span>{t(MESSAGES['file.count_limit'], { count: c.maxFiles })}</span> : null}
          </span>
        </span>
        <span className="fr-dropzone-browse" aria-hidden="true">{t(MESSAGES['file.browse'])}</span>
      </div>
      {files.length || pending.length ? (
        <ul className="fr-file-list" aria-live="polite">
          {files.map((f) => (
            <li key={f.fileId} className="fr-file">
              <span className="fr-file-name" aria-hidden="true">{f.name}</span>
              <span className="fr-sr-only">{t(MESSAGES['file.uploaded'], { name: f.name })}</span>
              {locked ? null : (
                <button type="button" className="fr-file-remove" aria-label={t(MESSAGES['file.remove'], { name: f.name })} onClick={() => remove(f.fileId)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 7l10 10M17 7L7 17" /></svg>
                </button>
              )}
            </li>
          ))}
          {pending.map((p) => (
            <li key={p.key} className="fr-file" data-error={p.error ? '' : undefined}>
              <span className="fr-file-name">{p.error ?? t(MESSAGES['file.uploading'], { name: p.name })}</span>
              {p.error ? (
                <button type="button" className="fr-file-remove" aria-label={t(MESSAGES['file.remove'], { name: p.name })} onClick={() => setPending((list) => list.filter((x) => x.key !== p.key))}>
                  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 7l10 10M17 7L7 17" /></svg>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
