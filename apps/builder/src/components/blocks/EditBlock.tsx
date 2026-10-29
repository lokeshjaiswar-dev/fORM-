import type { ComponentType } from 'react';
import { EyeOff } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { isAvailable, type AvailableType } from '@form/registry';
import type { StoredBlock } from '@form/schema';
import { t } from '@/i18n';
import { CANVAS, type CanvasProps } from '@/fields/canvas';
import { labelStyle } from '@/fields/style';
import { isField, plainText } from '@/lib/definition';
import { updateBlock } from '@/state/actions';
import { useUiStore } from '@/state/uiStore';
import { InlineEditor } from '@/components/editor/InlineEditor';

const M = defineMessages('builder', {
  'block.question': 'Type a question',
  'block.hidden_field': 'Hidden field name',
  'block.unavailable': 'This {type} block cannot be edited in this builder yet; it is kept as it is.',
  'block.hidden_until': 'Hidden until a rule shows it',
});

/** One block on the canvas: the label editor of a field and its type's canvas view (FND-03). */
export function EditBlock({ block }: { block: StoredBlock }) {
  const focused = useUiStore((s) => s.activeBlockId === block.id);
  const requestInsertFocus = useUiStore((s) => s.requestInsertFocus);

  if (block.type === 'unsupported' || !isAvailable(block.type)) {
    const type = block.type === 'unsupported' ? block.originalType : block.type;
    return <p className="rounded-md border border-dashed border-border px-3 py-2 text-[13px] text-muted-foreground">{t(M['block.unavailable'], { type })}</p>;
  }
  const View = CANVAS[block.type] as ComponentType<CanvasProps<AvailableType>>;
  const hidden = block.initiallyHidden ? (
    <p className="flex items-center gap-1 text-[12px] font-medium text-amber-700">
      <EyeOff className="size-3" /> {t(M['block.hidden_until'])}
    </p>
  ) : null;
  const props = { block, focused, onEnter: requestInsertFocus } as CanvasProps<AvailableType>;

  if (!isField(block)) {
    return (
      <div className="space-y-1">
        {hidden}
        <View {...props} />
      </div>
    );
  }

  return (
    <div className="w-full space-y-2" data-canvas-field="">
      {hidden}
      {!block.hideLabel && (
        <div className="flex h-8 min-w-0 items-center gap-1" data-canvas-label="">
          <InlineEditor
            value={block.label}
            onChange={(label) => updateBlock(block.id, { label })}
            onEnter={requestInsertFocus}
            autoFocus={focused}
            fill={false}
            editorClassName="whitespace-pre!"
            className="min-h-8 min-w-[12.5rem] whitespace-nowrap bg-transparent text-left text-[22px] font-semibold leading-8"
            style={labelStyle(block.style)}
            placeholder={t(block.type === 'hidden' ? M['block.hidden_field'] : M['block.question'])}
          />
          {block.required && <span className="shrink-0 text-[22px] font-semibold leading-8 text-black">*</span>}
        </div>
      )}
      {block.description ? <p className="text-left text-[13px] text-muted-foreground">{plainText(block.description)}</p> : null}
      <View {...props} />
    </div>
  );
}
