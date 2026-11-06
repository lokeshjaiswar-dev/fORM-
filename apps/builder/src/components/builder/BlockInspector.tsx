import { createElement, useState, type ComponentType } from 'react';
import { X } from 'lucide-react';
import { defineMessages, type MessageId } from '@form/i18n';
import { isAvailable, type AvailableType } from '@form/registry';
import { isSafeUrl, type BlockId, type BlockOf, type BlockStyle, type FieldBlock, type HexColor, type SafeUrl, type StoredBlock, type UniqueConstraint, type ValidationErrorCode } from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { INSPECTOR, type InspectorProps } from '@/fields/inspector';
import { tileOf } from '@/fields/tiles';
import { KEY_PATTERN, isField, placementOf, richDoc, takenKeys } from '@/lib/definition';
import { cn } from '@/lib/utils';
import { setBlockWidth, updateBlock } from '@/state/actions';
import { currentDoc, useBlock } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { Tooltip } from '@/components/Tooltip';
import { Button, Input, Label, Tabs, TabsContent, TabsList, TabsTrigger, ToggleGroup, ToggleGroupItem } from '@dmacq/ui';
import { RichEditor } from '@/components/editor/RichEditor';
import { Field, SectionTitle, SelectField, TextField, ToggleRow } from '@/components/builder/inspector/parts';
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
  'inspector.format_message': 'Message when the answer is invalid',
  'inspector.unique': 'Must be unique on this form',
  'inspector.unique_hint': 'The same value cannot be submitted twice. Checked when the form is submitted.',
  'inspector.unique_normalize': 'Compare as',
  'inspector.unique_exact': 'Exactly as typed',
  'inspector.unique_lower': 'Ignore case and extra spaces',
  'inspector.unique_e164': 'As a phone number',
  'inspector.unique_digits': 'Digits only',
  'inspector.unique_message': 'Message when the value is already used',
  'inspector.api_validation': 'Validate with an API',
  'inspector.api_url': 'API URL',
  'inspector.api_url_hint': 'The browser POSTs JSON using this field key ({key}) as the property name and the typed answer as the value. Respond with ok true, or ok false and a message.',
  'inspector.hidden_never_required': 'Hidden fields are never required.',
  'inspector.no_validation': 'This block has no answer to validate.',
});

const UNIQUE_TYPES = new Set<FieldBlock['type']>(['short_text', 'email', 'phone', 'url', 'number']);
const FORMAT_CODE: Partial<Record<FieldBlock['type'], ValidationErrorCode>> = {
  short_text: 'pattern',
  long_text: 'too_long',
  email: 'invalid_email',
  phone: 'invalid_phone',
  url: 'invalid_url',
  number: 'not_a_number',
  date: 'date_out_of_range',
  datetime: 'date_out_of_range',
  time: 'time_out_of_range',
  file_upload: 'file_type_not_allowed',
};

function defaultNormalize(type: FieldBlock['type']): UniqueConstraint['normalize'] {
  if (type === 'phone') return 'e164';
  if (type === 'number') return 'digits';
  return 'trim_lower';
}

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

  const open = inspectorOpen && !!block && block.type !== 'unsupported';
  if (!block || block.type === 'unsupported') {
    return (
      <aside
        className="relative flex shrink-0 flex-col overflow-hidden border-l border-transparent bg-background transition-[width,border-color] duration-300 ease-out"
        style={{ width: 0 }}
      />
    );
  }
  const tabs = tabsFor(block);
  const shown = tabs.includes(tab) ? tab : 'general';
  const typeName = tileOf(block.type, block.config as Readonly<Record<string, unknown>>)?.label ?? block.type;

  return (
    <aside
      aria-label={t(M['inspector.title'])}
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden border-l bg-background',
        open ? 'border-border' : 'border-transparent',
        !resizing && 'transition-[width,border-color] duration-300 ease-out',
      )}
      style={{ width: open ? inspectorWidth : 0 }}
    >
      <button
        type="button"
        aria-label={t(M['inspector.resize'])}
        className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-state-hover"
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
            <p className="text-[12px] text-muted-foreground">{typeName}</p>
          </div>
          <Tooltip content={t(M['inspector.close'])}>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['inspector.close'])} onClick={closeInspector}>
              <X className="size-4" />
            </Button>
          </Tooltip>
        </div>

        <Tabs value={shown} onValueChange={(id) => setTab(id as Tab)} size="sm" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="shrink-0 flex-nowrap overflow-x-auto px-3">
            {tabs.map((id) => (
              <TabsTrigger key={id} value={id}>
                {t(TAB_LABELS[id])}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value={shown} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
            {shown === 'general' ? <GeneralTab block={block} /> : null}
            {shown === 'options' ? <Registered block={block} section="options" /> : null}
            {shown === 'validation' && isField(block) ? <ValidationTab block={block} /> : null}
            {shown === 'logic' ? <LogicTab blockId={block.id} /> : null}
            {shown === 'privacy' && isField(block) ? <PrivacySection block={block} /> : null}
          </TabsContent>
        </Tabs>
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
    <div className="flex min-h-8 items-center justify-between gap-2">
      <Label className="min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">{label}</Label>
      <div className="flex shrink-0 items-center gap-1.5">
        <input type="color" aria-label={label} value={hex} onChange={(e) => onChange(e.target.value as HexColor)} className="size-7 shrink-0 cursor-pointer rounded border border-border" />
        <Input
          className="h-7 w-[92px] px-2 text-[12px]"
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

function inRepeatingGroup(id: BlockId): boolean {
  const at = placementOf(currentDoc(), id);
  return !!at && 'blockId' in at.parent;
}

function Look({ block, compact }: { block: Exclude<StoredBlock, { type: 'unsupported' }>; compact?: boolean }) {
  const style = block.style ?? {};
  const set = (patch: { [K in keyof BlockStyle]?: BlockStyle[K] | undefined }) => {
    const next: Record<string, unknown> = { ...style, ...patch };
    for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
    updateBlock(block.id, { style: Object.keys(next).length ? next : undefined });
  };
  const field = isField(block);
  const inputLook = field && block.type !== 'hidden' && block.type !== 'repeating_group';
  return (
    <>
      <SectionTitle>{t(M['inspector.look'])}</SectionTitle>
      <ColorField label={t(field ? M['inspector.label_color'] : M['inspector.text_color'])} value={style.labelColor} fallback="#111111" onChange={(labelColor) => set({ labelColor })} />
      {inputLook ? (
        <>
          <ColorField label={t(M['inspector.input_text_color'])} value={style.inputTextColor} fallback="#111111" onChange={(inputTextColor) => set({ inputTextColor })} />
          <ColorField label={t(M['inspector.input_bg'])} value={style.inputBg} fallback="#ffffff" onChange={(inputBg) => set({ inputBg })} />
          <ColorField label={t(M['inspector.border'])} value={style.borderColor} fallback="#e4e4e7" onChange={(borderColor) => set({ borderColor })} />
          <ColorField label={t(M['inspector.placeholder_color'])} value={style.placeholderColor} fallback="#a1a1aa" onChange={(placeholderColor) => set({ placeholderColor })} />
        </>
      ) : null}
      {compact ? null : (
        <ToggleGroup
          type="single"
          size="sm"
          appearance="tinted"
          className="w-full"
          aria-label={t(M['inspector.align'])}
          value={style.align ?? 'left'}
          onValueChange={(a) => a && set({ align: a === 'left' ? undefined : (a as 'center') })}
        >
          <ToggleGroupItem value="left" className="flex-1">{t(M['inspector.align_left'])}</ToggleGroupItem>
          <ToggleGroupItem value="center" className="flex-1">{t(M['inspector.align_center'])}</ToggleGroupItem>
        </ToggleGroup>
      )}
    </>
  );
}

function GeneralTab({ block }: { block: Exclude<StoredBlock, { type: 'unsupported' }> }) {
  const width = block.layout?.width ?? 'full';
  const nested = inRepeatingGroup(block.id);
  const list = block.type === 'repeating_group' || block.type === 'section';
  const skipWidth = nested || list;
  return (
    <>
      {isField(block) ? (
        <>
          <KeyField block={block} />
          {block.type !== 'hidden' ? (
            <>
              <Field label={t(M['inspector.description'])}>
                <div className="rounded-md border border-border px-2">
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
      {skipWidth ? null : (
        <Field label={t(M['inspector.width'])} hint={t(M['inspector.width_hint'])}>
          <ToggleGroup
            type="single"
            size="sm"
            appearance="tinted"
            className="w-full"
            aria-label={t(M['inspector.width'])}
            value={width}
            onValueChange={(w) => w && setBlockWidth(block.id, w as 'full' | 'half')}
          >
            <ToggleGroupItem value="full" className="flex-1">{t(M['inspector.width_full'])}</ToggleGroupItem>
            <ToggleGroupItem value="half" className="flex-1">{t(M['inspector.width_half'])}</ToggleGroupItem>
          </ToggleGroup>
        </Field>
      )}
      {block.type !== 'divider' ? <Look block={block} compact={nested || list} /> : null}
    </>
  );
}

function ApiUrlField({ block }: { block: FieldBlock }) {
  const stored = block.apiValidation?.url ?? '';
  const [text, setText] = useDraft(stored);
  return (
    <TextField
      label={t(M['inspector.api_url'])}
      hint={t(M['inspector.api_url_hint'], { key: block.key })}
      value={text}
      placeholder="http://localhost:3001/verify-name"
      onChange={(url) => {
        setText(url);
        if (!url) updateBlock(block.id, { apiValidation: undefined });
        else if (isSafeUrl(url)) updateBlock(block.id, { apiValidation: { url: url as SafeUrl } });
      }}
    />
  );
}

function ValidationTab({ block }: { block: FieldBlock }) {
  const hidden = block.type === 'hidden';
  const formatCode = FORMAT_CODE[block.type];
  const setMessage = (code: ValidationErrorCode, text: string) => {
    const messages: Partial<Record<ValidationErrorCode, string>> = { ...block.messages };
    if (text) messages[code] = text;
    else delete messages[code];
    updateBlock(block.id, { messages: Object.keys(messages).length ? messages : undefined });
  };
  return (
    <>
      {hidden ? (
        <p className="text-[13px] text-muted-foreground">{t(M['inspector.hidden_never_required'])}</p>
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
            <TextField label={t(M['inspector.required_message'])} placeholder={t(M['inspector.required_message_placeholder'])} value={block.messages?.required} onChange={(text) => setMessage('required', text)} />
          ) : null}
        </>
      )}
      <ToggleRow
        label={t(M['inspector.api_validation'])}
        checked={block.apiValidation !== undefined}
        onChange={(on) => updateBlock(block.id, { apiValidation: on ? { url: 'http://localhost:3001/verify-name' as SafeUrl } : undefined })}
      />
      {block.apiValidation ? <ApiUrlField block={block} /> : null}
      <Registered block={block} section="validation" />
      {formatCode ? (
        <TextField label={t(M['inspector.format_message'])} value={block.messages?.[formatCode]} onChange={(text) => setMessage(formatCode, text)} />
      ) : null}
      {UNIQUE_TYPES.has(block.type) ? (
        <>
          <ToggleRow
            label={t(M['inspector.unique'])}
            hint={t(M['inspector.unique_hint'])}
            checked={block.unique !== undefined}
            onChange={(on) => updateBlock(block.id, { unique: on ? { normalize: defaultNormalize(block.type) } : undefined })}
          />
          {block.unique ? (
            <>
              <SelectField
                label={t(M['inspector.unique_normalize'])}
                value={block.unique.normalize}
                options={[
                  { value: 'exact', label: t(M['inspector.unique_exact']) },
                  { value: 'trim_lower', label: t(M['inspector.unique_lower']) },
                  { value: 'e164', label: t(M['inspector.unique_e164']) },
                  { value: 'digits', label: t(M['inspector.unique_digits']) },
                ]}
                onChange={(normalize) => updateBlock(block.id, { unique: { ...block.unique, normalize: normalize as UniqueConstraint['normalize'] } })}
              />
              <TextField label={t(M['inspector.unique_message'])} value={block.unique.message} onChange={(message) => updateBlock(block.id, { unique: { ...block.unique, message: message || undefined } })} />
            </>
          ) : null}
        </>
      ) : null}
      {!sectionOf(block, 'validation') && hidden ? <p className="text-[13px] text-muted-foreground">{t(M['inspector.no_validation'])}</p> : null}
    </>
  );
}

