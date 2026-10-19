import { createElement, useState, type ComponentType } from 'react';
import { X } from 'lucide-react';
import { defineMessages, type MessageId } from '@form/i18n';
import { isAvailable, type AvailableType } from '@form/registry';
import type { BlockId, BlockOf, BlockStyle, FieldBlock, HexColor, StoredBlock } from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { INSPECTOR, type InspectorProps } from '@/fields/inspector';
import { tileOf } from '@/fields/tiles';
import { KEY_PATTERN, isField, richDoc, takenKeys } from '@/lib/definition';
import { cn } from '@/lib/utils';
import { setBlockWidth, updateBlock } from '@/state/actions';
import { currentDoc, useBlock } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { Tooltip } from '@/components/ui/tooltip';
import { Input, Label } from '@/components/ui/input';
import { RichEditor } from '@/components/editor/RichEditor';
import { Field, SectionTitle, TextField, ToggleRow } from '@/components/builder/inspector/parts';
import { LogicTab } from '@/components/builder/inspector/LogicTab';
import { PrivacySection } from '@/components/builder/inspector/PrivacySection';

const M = defineMessages('builder', {
  'inspector.title': 'Block settings',
  'inspector.close': 'Close settings',
  'inspector.resize': 'Resize settings',
  'inspector.tab.general': 'General',
  'inspector.tab.options': 'Options',
  'inspector.tab.validation': 'Validation',
  'inspector.tab.logic': 'Logic',
  'inspector.tab.privacy': 'Privacy',
  'inspector.key': 'Field key',
  'inspector.key_hint': 'Used in exports, the API and URL prefill. Lower-case letters, digits and _.',
  'inspector.key_invalid': 'Use a free key of lower-case letters, digits and _, starting with a letter',
  'inspector.description': 'Helper text',
  'inspector.description_placeholder': 'Hint below the question',
  'inspector.hide_label': 'Hide label',
  'inspector.width': 'Block width',
  'inspector.width_full': 'Full',
  'inspector.width_half': 'Half',
  'inspector.width_hint': 'Half keeps this block on its own row. Drag another block onto it to sit beside it.',
  'inspector.look': 'Look',
  'inspector.label_color': 'Question colour',
  'inspector.input_text_color': 'Answer colour',
  'inspector.input_bg': 'Input background',
  'inspector.border': 'Border',
  'inspector.color_code': '{label} hex code',
  'inspector.placeholder_color': 'Placeholder colour',
  'inspector.text_color': 'Text colour',
  'inspector.align': 'Align',
  'inspector.align_left': 'Left',
  'inspector.align_center': 'Center',
  'inspector.required': 'Required',
  'inspector.read_only': 'Read-only',
  'inspector.read_only_hint': 'Shown and submitted, but not editable',
  'inspector.required_read_only': 'A read-only field needs a default value to be required.',
  'inspector.required_message': 'Message when empty',
  'inspector.required_message_placeholder': 'This field is required.',
  'inspector.hidden_never_required': 'Hidden fields are never required.',
  'inspector.no_validation': 'This block has no answer to validate.',
});

type Tab = 'general' | 'options' | 'validation' | 'logic' | 'privacy';
const TAB_LABELS: Record<Tab, MessageId> = {
  general: M['inspector.tab.general'],
  options: M['inspector.tab.options'],
  validation: M['inspector.tab.validation'],
  logic: M['inspector.tab.logic'],
  privacy: M['inspector.tab.privacy'],
};

type Section = 'general' | 'options' | 'validation';
const sectionOf = (block: StoredBlock, section: Section): ComponentType<InspectorProps<AvailableType>> | undefined =>
  isAvailable(block.type) ? (INSPECTOR[block.type][section] as ComponentType<InspectorProps<AvailableType>> | undefined) : undefined;

function tabsFor(block: StoredBlock): Tab[] {
  const tabs: Tab[] = ['general'];
  if (sectionOf(block, 'options')) tabs.push('options');
  if (isField(block)) tabs.push('validation');
  tabs.push('logic');
  if (isField(block)) tabs.push('privacy');
  return tabs;
}

/** The Block settings panel for the selected block: registry-driven sections (FND-03). */
export function BlockInspector() {
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);
  const setInspectorWidth = useUiStore((s) => s.setInspectorWidth);
  const activeBlockId = useUiStore((s) => s.activeBlockId);
  const closeInspector = useUiStore((s) => s.closeInspector);
  const block = useBlock(activeBlockId ?? ('' as BlockId));
  const [resizing, setResizing] = useState(false);
  /* The picked tab belongs to the block it was picked on: another block opens on General. */
  const [picked, setPicked] = useState<{ id: BlockId | null; tab: Tab }>({ id: activeBlockId, tab: 'general' });
  const tab = picked.id === activeBlockId ? picked.tab : 'general';
  const setTab = (next: Tab) => setPicked({ id: activeBlockId, tab: next });

  if (!block || block.type === 'unsupported' || !inspectorOpen) return <aside className="w-0 shrink-0 overflow-hidden border-l border-transparent" />;
  const open = inspectorOpen;
  const tabs = tabsFor(block);
  const shown = tabs.includes(tab) ? tab : 'general';
  const typeName = tileOf(block.type, block.config as Readonly<Record<string, unknown>>)?.label ?? block.type;

  return (
    <aside
      aria-label={t(M['inspector.title'])}
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden border-l bg-white',
        open ? 'border-[var(--notion-border)]' : 'border-transparent',
        !resizing && 'transition-[width,border-color] duration-300 ease-out',
      )}
      style={{ width: open ? inspectorWidth : 0 }}
    >
      <button
        type="button"
        aria-label={t(M['inspector.resize'])}
        className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-zinc-300"
        onMouseDown={(e) => {
          e.preventDefault();
          setResizing(true);
          const startX = e.clientX;
          const startW = inspectorWidth;
          function move(ev: MouseEvent) {
            setInspectorWidth(startW + (startX - ev.clientX));
          }
          function up() {
            setResizing(false);
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
          }
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        }}
      />
      <div className="flex min-h-0 flex-1 flex-col" style={{ width: inspectorWidth }}>
        <div className="flex items-center justify-between px-4 py-3">
          <div>
            <h2 className="text-[14px] font-semibold">{t(M['inspector.title'])}</h2>
            <p className="text-[12px] text-[var(--notion-text-muted)]">{typeName}</p>
          </div>
          <Tooltip content={t(M['inspector.close'])}>
            <button type="button" aria-label={t(M['inspector.close'])} className="flex size-6 items-center justify-center rounded-[4px] hover:bg-[var(--notion-hover)]" onClick={closeInspector}>
              <X className="size-4" />
            </button>
          </Tooltip>
        </div>

        <div className="flex gap-1 border-b border-[var(--notion-border)] px-3" role="tablist">
          {tabs.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={shown === id}
              onClick={() => setTab(id)}
              className={cn(
                '-mb-px border-b-2 px-2 py-2 text-[12px] font-medium',
                shown === id ? 'border-[#111] text-[#111]' : 'border-transparent text-[var(--notion-text-muted)] hover:text-[#111]',
              )}
            >
              {t(TAB_LABELS[id])}
            </button>
          ))}
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4" role="tabpanel">
          {shown === 'general' ? <GeneralTab block={block} /> : null}
          {shown === 'options' ? <Registered block={block} section="options" /> : null}
          {shown === 'validation' && isField(block) ? <ValidationTab block={block} /> : null}
          {shown === 'logic' ? <LogicTab blockId={block.id} /> : null}
          {shown === 'privacy' && isField(block) ? <PrivacySection block={block} /> : null}
        </div>
      </div>
    </aside>
  );
}

function Registered({ block, section }: { block: StoredBlock; section: Section }) {
  const view = sectionOf(block, section);
  return view ? createElement(view, { block: block as BlockOf<AvailableType> }) : null;
}

function KeyField({ block }: { block: FieldBlock }) {
  const [text, setText] = useDraft<string>(block.key);
  const valid = KEY_PATTERN.test(text) && !takenKeys(currentDoc(), block.id).has(text);
  return (
    <Field label={t(M['inspector.key'])} hint={t(M['inspector.key_hint'])} error={valid ? null : t(M['inspector.key_invalid'])}>
      <Input
        aria-label={t(M['inspector.key'])}
        value={text}
        onChange={(e) => {
          const next = e.target.value.toLowerCase();
          setText(next);
          if (KEY_PATTERN.test(next) && !takenKeys(currentDoc(), block.id).has(next)) updateBlock(block.id, { key: next });
        }}
      />
    </Field>
  );
}

const HEX = /^#[0-9a-fA-F]{6}$/;

function ColorField({ label, value, fallback, onChange }: { label: string; value: BlockStyle[keyof BlockStyle]; fallback: string; onChange: (v: HexColor | undefined) => void }) {
  const hex = typeof value === 'string' && HEX.test(value) ? value : fallback;
  const [text, setText] = useDraft(typeof value === 'string' ? value : '');
  return (
    <div className="flex items-center justify-between gap-2">
      <Label className="text-[12px] text-[var(--notion-text-muted)]">{label}</Label>
      <div className="flex items-center gap-1.5">
        <input type="color" aria-label={label} value={hex} onChange={(e) => onChange(e.target.value as HexColor)} className="size-7 cursor-pointer rounded border border-zinc-200" />
        <Input
          className="w-[92px]"
          aria-label={t(M['inspector.color_code'], { label })}
          value={text}
          placeholder={fallback}
          onChange={(e) => {
            setText(e.target.value);
            const next = e.target.value.trim();
            if (!next) onChange(undefined);
            else if (HEX.test(next)) onChange(next as HexColor);
          }}
        />
      </div>
    </div>
  );
}

function Look({ block }: { block: Exclude<StoredBlock, { type: 'unsupported' }> }) {
  const style = block.style ?? {};
  const set = (patch: { [K in keyof BlockStyle]?: BlockStyle[K] | undefined }) => {
    const next: Record<string, unknown> = { ...style, ...patch };
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
    updateBlock(block.id, { style: Object.keys(next).length ? next : undefined });
  };
  const field = isField(block);
  return (
    <>
      <SectionTitle>{t(M['inspector.look'])}</SectionTitle>
      <ColorField label={t(field ? M['inspector.label_color'] : M['inspector.text_color'])} value={style.labelColor} fallback="#111111" onChange={(labelColor) => set({ labelColor })} />
      {field && block.type !== 'hidden' ? (
        <>
          <ColorField label={t(M['inspector.input_text_color'])} value={style.inputTextColor} fallback="#111111" onChange={(inputTextColor) => set({ inputTextColor })} />
          <ColorField label={t(M['inspector.input_bg'])} value={style.inputBg} fallback="#ffffff" onChange={(inputBg) => set({ inputBg })} />
          <ColorField label={t(M['inspector.border'])} value={style.borderColor} fallback="#e4e4e7" onChange={(borderColor) => set({ borderColor })} />
          <ColorField label={t(M['inspector.placeholder_color'])} value={style.placeholderColor} fallback="#a1a1aa" onChange={(placeholderColor) => set({ placeholderColor })} />
        </>
      ) : null}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1" role="group" aria-label={t(M['inspector.align'])}>
        {(['left', 'center'] as const).map((a) => (
          <button
            key={a}
            type="button"
            aria-pressed={(style.align ?? 'left') === a}
            className={cn('rounded-md px-2 py-1.5 text-[13px] font-medium', (style.align ?? 'left') === a ? 'bg-white shadow-sm' : 'text-zinc-500 hover:text-[#111]')}
            onClick={() => set({ align: a === 'left' ? undefined : a })}
          >
            {t(a === 'left' ? M['inspector.align_left'] : M['inspector.align_center'])}
          </button>
        ))}
      </div>
    </>
  );
}

function GeneralTab({ block }: { block: Exclude<StoredBlock, { type: 'unsupported' }> }) {
  const width = block.layout?.width ?? 'full';
  return (
    <>
      {isField(block) ? (
        <>
          <KeyField block={block} />
          {block.type !== 'hidden' ? (
            <>
              <Field label={t(M['inspector.description'])}>
                <div className="rounded-md border border-zinc-200 px-2">
                  <RichEditor
                    value={block.description ?? richDoc('')}
                    onChange={(description) => updateBlock(block.id, { description: description.content.some((n) => n.type !== 'paragraph' || n.content?.length) ? description : undefined })}
                    placeholder={t(M['inspector.description_placeholder'])}
                    className="text-[13px] leading-6"
                  />
                </div>
              </Field>
              <ToggleRow label={t(M['inspector.hide_label'])} checked={block.hideLabel === true} onChange={(on) => updateBlock(block.id, { hideLabel: on || undefined })} />
            </>
          ) : null}
        </>
      ) : null}
      <Registered block={block} section="general" />
      <Field label={t(M['inspector.width'])} hint={t(M['inspector.width_hint'])}>
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-100 p-1" role="group" aria-label={t(M['inspector.width'])}>
          {(['full', 'half'] as const).map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={width === w}
              className={cn('rounded-md px-2 py-1.5 text-[13px] font-medium', width === w ? 'bg-white shadow-sm' : 'text-zinc-500 hover:text-[#111]')}
              onClick={() => setBlockWidth(block.id, w)}
            >
              {t(w === 'full' ? M['inspector.width_full'] : M['inspector.width_half'])}
            </button>
          ))}
        </div>
      </Field>
      {block.type !== 'divider' ? <Look block={block} /> : null}
    </>
  );
}

function ValidationTab({ block }: { block: FieldBlock }) {
  const hidden = block.type === 'hidden';
  const message = block.messages?.required;
  const setMessage = (text: string) => {
    const messages: Record<string, string> = { ...block.messages };
    if (text) messages['required'] = text;
    else delete messages['required'];
    updateBlock(block.id, { messages: Object.keys(messages).length ? messages : undefined });
  };
  return (
    <>
      {hidden ? (
        <p className="text-[13px] text-[var(--notion-text-muted)]">{t(M['inspector.hidden_never_required'])}</p>
      ) : (
        <>
          <ToggleRow label={t(M['inspector.required'])} checked={block.required} onChange={(required) => updateBlock(block.id, { required })} />
          <ToggleRow label={t(M['inspector.read_only'])} hint={t(M['inspector.read_only_hint'])} checked={block.readOnly === true} onChange={(on) => updateBlock(block.id, { readOnly: on || undefined })} />
          {block.required && block.readOnly ? (
            <p role="alert" className="text-[12px] text-amber-700">
              {t(M['inspector.required_read_only'])}
            </p>
          ) : null}
          {block.required ? (
            <TextField label={t(M['inspector.required_message'])} placeholder={t(M['inspector.required_message_placeholder'])} value={message} onChange={setMessage} />
          ) : null}
        </>
      )}
      <Registered block={block} section="validation" />
      {!sectionOf(block, 'validation') && hidden ? <p className="text-[13px] text-[var(--notion-text-muted)]">{t(M['inspector.no_validation'])}</p> : null}
    </>
  );
}

