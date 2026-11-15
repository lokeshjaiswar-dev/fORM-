import { useRef, useState } from 'react';
import { X } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import type { PlainTemplate } from '@form/schema';
import { Input } from '@dmacq/ui';
import { t } from '@/i18n';
import { NiceSelect } from '@/components/NiceSelect';
import { answerPipe, fromSegments, insertChip, removeChip, setText, toSegments, type Caret, type FieldRef } from '@/components/settings/notificationsModel';

const M = defineMessages('builder', {
  'notification_subject.label': 'Subject',
  'notification_subject.group': 'Email subject',
  'notification_subject.part': 'Subject, part {n}',
  'notification_subject.insert': 'Insert field',
  'notification_subject.insert_label': 'Insert a field into the subject',
  'notification_subject.no_fields': 'The form has no fields to insert yet.',
  'notification_subject.hint': 'Insert a field to put the respondent’s answer in the subject. Do not use fields that hold private details: a subject is shown in inboxes and notifications.',
  'notification_subject.remove': 'Remove {field} from the subject',
  'notification_subject.gone': 'A field that is no longer in the form',
});

/**
 * An email subject: text and answers piped in (`PlainTemplate`), edited as boxes of text with a chip for each field between
 * them. Insert field puts a chip where the caret was in the text, or at the end. Only value blocks are offered (`fields`):
 * a paragraph or a section break holds no answer, so there is nothing to pipe. The subject is a plain line: it cannot hold a
 * line break, and a subject that names a field the form no longer has is shown with a placeholder chip and still saves.
 */
export function SubjectField({ value, onChange, fields }: { value: PlainTemplate; onChange: (next: PlainTemplate) => void; fields: readonly FieldRef[] }) {
  const segments = toSegments(value);
  // Where the caret last was in one of the text boxes; Insert field puts the chip there.
  const caret = useRef<Caret | null>(null);
  // The select never holds a choice, so it starts afresh after each insert.
  const [inserted, setInserted] = useState(0);
  const labels = new Map(fields.map((f) => [f.id, f.label]));

  const remember = (index: number, input: HTMLInputElement) => {
    caret.current = { index, offset: input.selectionStart ?? input.value.length };
  };

  const insert = (blockId: string) => {
    onChange(fromSegments(insertChip(segments, caret.current, answerPipe(blockId))));
    // A chip is now where the caret was; the pieces of text have moved on.
    caret.current = null;
    setInserted((n) => n + 1);
  };

  return (
    <div className="space-y-1.5">
      <span className="block text-[13px] font-medium text-foreground">{t(M['notification_subject.label'])}</span>
      <div role="group" aria-label={t(M['notification_subject.group'])} className="flex flex-wrap items-center gap-1.5 rounded-md border border-border px-2 py-1.5">
        {segments.map((part, i) => {
          if (i % 2 === 0) {
            return (
              <Input
                key={`text-${i}`}
                aria-label={i === 0 ? t(M['notification_subject.label']) : t(M['notification_subject.part'], { n: i / 2 + 1 })}
                value={part as string}
                maxLength={300}
                onChange={(e) => {
                  remember(i, e.target);
                  onChange(fromSegments(setText(segments, i, e.target.value.replace(/[\r\n]+/g, ' '))));
                }}
                onSelect={(e) => remember(i, e.currentTarget)}
                onBlur={(e) => remember(i, e.currentTarget)}
                className={i === 0 && segments.length === 1 ? 'min-w-[240px] flex-1' : 'min-w-[96px] flex-1'}
              />
            );
          }
          const chip = part as Exclude<typeof part, string>;
          const blockId = 'pipe' in chip && chip.pipe.source.kind === 'answer' ? chip.pipe.source.blockId : null;
          const label = blockId === null ? 'var' in chip ? `{${chip.var.name}}` : t(M['notification_subject.gone']) : (labels.get(blockId) ?? t(M['notification_subject.gone']));
          return (
            <span key={`chip-${i}`} className="inline-flex max-w-full items-center gap-1 rounded bg-surface-subtle px-1.5 py-0.5 text-[13px] text-foreground">
              <span className="truncate">{label}</span>
              <button
                type="button"
                className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1"
                aria-label={t(M['notification_subject.remove'], { field: label })}
                onClick={() => onChange(fromSegments(removeChip(segments, i)))}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </span>
          );
        })}
      </div>
      <div className="max-w-[260px]">
        <NiceSelect
          key={inserted}
          size="sm"
          aria-label={t(M['notification_subject.insert_label'])}
          placeholder={t(M['notification_subject.insert'])}
          value=""
          disabled={fields.length === 0}
          onChange={insert}
          options={fields.map((f) => ({ value: f.id, label: f.label }))}
        />
      </div>
      <p className="text-[12px] text-muted-foreground">{fields.length === 0 ? t(M['notification_subject.no_fields']) : t(M['notification_subject.hint'])}</p>
    </div>
  );
}
