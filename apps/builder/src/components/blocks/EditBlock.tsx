import type { ComponentType } from 'react';
import { EyeOff } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { isAvailable, type AvailableType } from '@form/registry';
import type { StoredBlock } from '@form/schema';
import { t } from '@/i18n';
import { CANVAS, type CanvasProps } from '@/fields/canvas';
import { blockStyleVars, labelStyle } from '@/fields/style';
import { isField, plainText } from '@/lib/definition';
import { cn } from '@/lib/utils';
import { focusNextField, updateBlock } from '@/state/actions';
import { useUiStore } from '@/state/uiStore';
import { InlineEditor } from '@/components/editor/InlineEditor';

const M = defineMessages('builder', {
  'block.question': 'Type a question',
  'block.hidden_field': 'Hidden field name',
  'block.unavailable': 'This {type} block cannot be edited in this builder yet; it is kept as it is.',
  'block.hidden_until': 'Hidden until a rule shows it',
  'block.concealed': 'Hidden from respondents',
});

/** One block on the canvas: the label editor of a field and its type's canvas view (FND-03). */
export function EditBlock({ block }: { block: StoredBlock }) {
  const focused = useUiStore((s) => s.activeBlockId === block.id);

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
  const props = { block, focused, onEnter: () => focusNextField(block.id) } as CanvasProps<AvailableType>;

  if (!isField(block)) {
    return (
      <div className="space-y-1">
        {hidden}
        <View {...props} />
      </div>
    );
  }

  /* A Hidden (concealed) field stays fully editable here, but reads as set aside: a badge and a dimmed body. */
  const concealed = block.concealed === true && block.type !== 'hidden';

  /*
   * Spacing mirrors the published form (renderer `.fr-label`, `.fr-description`), so the canvas shows what respondents
   * see: the description sits directly under its label as one unit, and the control follows a step further away
   * (8px after a description, 6px straight after the label). The asterisk sits flush against the label's last word.
   */
  return (
    <div className="w-full" data-canvas-field="" style={blockStyleVars(block.style)}>
      {hidden || concealed ? (
        <div className="mb-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {concealed ? (
            <p className="inline-flex items-center gap-1 rounded-sm bg-muted px-1.5 py-0.5 text-[12px] font-medium text-muted-foreground" data-canvas-concealed="">
              <EyeOff aria-hidden className="size-3" /> {t(M['block.concealed'])}
            </p>
          ) : null}
          {hidden}
        </div>
      ) : null}
      <div className={cn(concealed && 'opacity-60')}>
        {!block.hideLabel && (
          /* No gap before the asterisk, as on the published form; the 6px step only follows when no description does. */
          <div
            className={cn('flex min-w-0 items-start text-[length:var(--fr-label-size,1em)] font-medium leading-normal', !block.description && 'mb-1.5')}
            data-canvas-label=""
          >
            <InlineEditor
              value={block.label}
              onChange={(label) => updateBlock(block.id, { label })}
              onEnter={() => focusNextField(block.id)}
              autoFocus={focused}
              fill={false}
              hug
              frameClassName="min-h-0"
              className="max-w-full bg-transparent text-left text-[length:var(--fr-label-size,1em)] font-medium leading-normal text-[var(--fr-label-color,var(--fr-text))]"
              style={labelStyle(block.style)}
              placeholder={t(block.type === 'hidden' ? M['block.hidden_field'] : M['block.question'])}
            />
            {block.required ? (
              <span className="fr-required shrink-0" aria-hidden="true">
                <span>*</span>
              </span>
            ) : null}
          </div>
        )}
        {/* Directly under the label (the renderer's `.fr-label + .fr-description` rule); the inline style beats `.fr-description`'s -2px. */}
        {block.description ? (
          <p className="fr-description text-start" style={block.hideLabel ? undefined : { marginTop: 0 }}>
            {plainText(block.description)}
          </p>
        ) : null}
        <View {...props} />
      </div>
    </div>
  );
}
