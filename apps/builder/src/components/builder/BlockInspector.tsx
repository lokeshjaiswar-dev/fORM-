import { createElement, useState, type ComponentType } from 'react';
import { Asterisk, EyeOff, Lock, X } from 'lucide-react';
import { toast } from 'sonner';
import { defineMessages, type MessageId } from '@form/i18n';
import { isAvailable, type AvailableType } from '@form/registry';
import { type BlockId, type BlockOf, type BlockStyle, type DecimalString, type FieldBlock, type HexColor, type OptionId, type StoredBlock, type UniqueConstraint, type ValidationErrorCode } from '@form/schema';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { INSPECTOR, type InspectorProps } from '@/fields/inspector';
import { labelString } from '@/fields/style';
import { tileOf } from '@/fields/tiles';
import { KEY_PATTERN, blockText, isField, placementOf, plainText, richDoc, takenKeys } from '@/lib/definition';
import { patchBlockConfig } from '@/fields/configSink';
import { isCustomFieldType, parseConfig } from '@/fields/custom/model';
import { saveLibraryField } from '@/fields/custom/repository';
import { cn } from '@/lib/utils';
import { setBlockWidth, updateBlock } from '@/state/actions';
import { isOptionValueField } from '@/state/commands/rules';
import { currentDoc, useBlock, useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { Tooltip } from '@/components/Tooltip';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label, Tabs, TabsContent, TabsList, TabsTrigger, ToggleGroup, ToggleGroupItem } from '@dmacq/ui';
import { RichEditor } from '@/components/editor/RichEditor';
import { InlineEditor } from '@/components/editor/InlineEditor';
import { Field, InspectorSection, SectionTitle, SelectField, TextField, ToggleRow } from '@/components/builder/inspector/parts';
import { ApiValidationSection } from '@/components/builder/inspector/ApiValidationSection';
import { LogicTab } from '@/components/builder/inspector/LogicTab';
import { PrivacySection } from '@/components/builder/inspector/PrivacySection';
import { SUBMIT_INSPECTOR_ID, SubmitInspector } from '@/components/builder/SubmitInspector';
import { TITLE_INSPECTOR_ID, TitleInspector } from '@/components/builder/TitleInspector';

const M = defineMessages('builder', {
  'inspector.title': 'Block settings',
  'inspector.field_name': 'Field name',
  'inspector.field_name_placeholder': 'Type a question',
  'inspector.field_type': 'Field type',
  'inspector.section.options': 'Options',
  'inspector.section.customization': 'Customization',
  'inspector.section.validation': 'Validation',
  'inspector.section.advanced': 'Advanced',
  'inspector.section.layout': 'Layout',
  'inspector.section.colours': 'Colours',
  'inspector.section.messages': 'Error messages',
  'inspector.section.privacy': 'Privacy',
  'inspector.close': 'Close settings',
  'inspector.resize': 'Resize settings',
  'inspector.tab.general': 'General',
  'inspector.tab.design': 'Design',
  'inspector.tab.logic': 'Logic',
  'inspector.key': 'Field key',
  'inspector.key_hint': 'Used in exports, the API and URL prefill. Lower-case letters, digits and _.',
  'inspector.key_invalid': 'Use a free key of lower-case letters, digits and _, starting with a letter',
  'inspector.description': 'Description',
  'inspector.description_placeholder': 'Hint below the question',
  'inspector.hide_label': 'Hide label',
  'inspector.width': 'Block width',
  'inspector.width_full': 'Full',
  'inspector.width_half': 'Half',
  'inspector.width_hint': 'Half keeps this block on its own row. Drag another block onto it to sit beside it.',
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
  'inspector.read_only_value': 'Value shown in the field',
  'inspector.read_only_value_hint': 'Respondents see this and it is submitted. Rules can read it.',
  'inspector.concealed_value': 'Value stored for this field',
  'inspector.concealed_value_hint': 'Respondents do not see this. It is submitted, and rules can read it anywhere.',
  'inspector.required_read_only': 'A read-only field needs a default value to be required.',
  'inspector.concealed': 'Hidden',
  'inspector.required_concealed': 'Respondents cannot fill a hidden field, so it needs a default value or prefill to be required.',
  'inspector.required_message': 'Message when empty',
  'inspector.required_message_placeholder': 'This field is required.',
  'inspector.format_message': 'Message when the answer is invalid',
  'inspector.unique': 'Must be unique on this form',
  'inspector.primary_key': 'Primary key',
  'inspector.primary_key_hint': 'Identifies each submission. Turning it on also makes the field required and unique. Only one field per form can be the primary key.',
  'inspector.primary_key_moved': 'Turning this on moves the primary key from {field}.',
  'inspector.primary_key_locked': 'Kept on while this field is the primary key.',
  'inspector.unique_hint': 'The same value cannot be submitted twice. Checked when the form is submitted.',
  'inspector.unique_normalize': 'Compare as',
  'inspector.unique_exact': 'Exactly as typed',
  'inspector.unique_lower': 'Ignore case and extra spaces',
  'inspector.unique_e164': 'As a phone number',
  'inspector.unique_digits': 'Digits only',
  'inspector.unique_message': 'Message when the value is already used',
  'inspector.save_field': 'Save as field',
  'inspector.save_field_title': 'Save as a reusable field',
  'inspector.save_field_help': 'This stores the type, settings and validation so you can add it from the palette.',
  'inspector.save_field_name': 'Name',
  'inspector.save_field_done': 'Saved. You can add it from Your fields in the sidebar.',
  'inspector.save_field_fail': 'This field could not be saved.',
  'inspector.submit_type': 'Submit button',
  'inspector.form_title_type': 'Form title',
});

const UNIQUE_TYPES = new Set<FieldBlock['type']>(['short_text', 'email', 'phone', 'url', 'number']);
/** The fields that can identify a submission, as in a DMS master: text, number, email and phone. */
const PRIMARY_KEY_TYPES = new Set<FieldBlock['type']>(['short_text', 'number', 'email', 'phone']);
/**
 * The answers an external API can sensibly check: typed values and picked options. Widgets such as a signature, a
 * file or a card sort have no value an API could verify; a block that already has a check keeps showing it.
 */
const API_CHECK_TYPES = new Set<FieldBlock['type']>(['short_text', 'long_text', 'email', 'phone', 'url', 'number', 'full_name', 'address', 'date', 'datetime', 'time', 'single_choice', 'multi_choice']);
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

/*
 * Three tabs, one per question an author asks: what is this block (General), how does it look (Design), when does it
 * show or change (Logic). Everything about the block's content, options and answers is on General, ordered by how
 * often it is set, with the rarely needed settings folded at the end; nothing essential sits behind a second tab.
 */
type Tab = 'general' | 'design' | 'logic';
const TAB_LABELS: Record<Tab, MessageId> = {
  general: M['inspector.tab.general'],
  design: M['inspector.tab.design'],
  logic: M['inspector.tab.logic'],
};

type Section = 'general' | 'options' | 'validation';
const sectionOf = (block: StoredBlock, section: Section): ComponentType<InspectorProps<AvailableType>> | undefined =>
  isAvailable(block.type) ? (INSPECTOR[block.type][section] as ComponentType<InspectorProps<AvailableType>> | undefined) : undefined;

type ShownBlock = Exclude<StoredBlock, { type: 'unsupported' }>;

/** Inside a repeating group or a list block, a block takes its row's width and has no alignment of its own. */
const isCompact = (block: ShownBlock): boolean => inRepeatingGroup(block.id) || block.type === 'repeating_group' || block.type === 'section';

/** A hidden field never shows on the form, and a divider has no text to align or colour. */
const hasDesign = (block: ShownBlock): boolean => block.type !== 'hidden' && block.type !== 'divider';

function tabsFor(block: ShownBlock): Tab[] {
  const tabs: Tab[] = [];
  if (isField(block) || sectionOf(block, 'general') || sectionOf(block, 'options') || !isCompact(block)) tabs.push('general');
  if (hasDesign(block)) tabs.push('design');
  tabs.push('logic');
  return tabs;
}

/** Share of the viewport the panel may take, so smaller desktop screens keep room for the canvas. */
const PANEL_VIEWPORT_SHARE = '28vw';
const PANEL_MIN_WIDTH = 280;

/** The panel's CSS width: the author's chosen width, capped to a share of the viewport but never below the minimum. */
function inspectorPanelWidth(width: number): string {
  return `min(${width}px, max(${PANEL_MIN_WIDTH}px, ${PANEL_VIEWPORT_SHARE}))`;
}

/** The drag handle on the panel's left edge. Dragging starts from the width shown, which the viewport cap may have narrowed. */
function ResizeHandle({ onResizing }: { onResizing: (resizing: boolean) => void }) {
  const setInspectorWidth = useUiStore((s) => s.setInspectorWidth);
  return (
    <button
      type="button"
      aria-label={t(M['inspector.resize'])}
      className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize hover:bg-state-hover"
      onMouseDown={(e) => {
        e.preventDefault();
        onResizing(true);
        const startX = e.clientX;
        const startW = e.currentTarget.parentElement?.getBoundingClientRect().width ?? useUiStore.getState().inspectorWidth;
        function move(ev: MouseEvent) {
          setInspectorWidth(startW + (startX - ev.clientX));
        }
        function up() {
          onResizing(false);
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        }
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
    />
  );
}

/** The Block settings panel for the selected block: registry-driven sections (FND-03). */
export function BlockInspector() {
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const panelWidth = inspectorPanelWidth(useUiStore((s) => s.inspectorWidth));
  const activeBlockId = useUiStore((s) => s.activeBlockId);
  const closeInspector = useUiStore((s) => s.closeInspector);
  const submitSelected = activeBlockId === SUBMIT_INSPECTOR_ID;
  const titleSelected = activeBlockId === TITLE_INSPECTOR_ID;
  const chromeSelected = submitSelected || titleSelected;
  const block = useBlock(chromeSelected ? ('' as BlockId) : (activeBlockId ?? ('' as BlockId)));
  const linkedValue = useDoc((d) => (activeBlockId && !chromeSelected ? isOptionValueField(d, activeBlockId) : false));
  const [resizing, setResizing] = useState(false);
  /* The picked tab belongs to the block it was picked on: another block opens on General. */
  const [picked, setPicked] = useState<{ id: BlockId | null; tab: Tab }>({ id: activeBlockId, tab: 'general' });
  const tab = picked.id === activeBlockId ? picked.tab : 'general';
  const setTab = (next: Tab) => setPicked({ id: activeBlockId, tab: next });

  const open = inspectorOpen && !linkedValue && (chromeSelected || (!!block && block.type !== 'unsupported'));
  if (!chromeSelected && (!block || block.type === 'unsupported')) {
    return (
      <aside
        className="relative flex shrink-0 flex-col overflow-hidden border-l border-transparent bg-background transition-[width,border-color] duration-300 ease-out"
        style={{ width: 0 }}
      />
    );
  }
  if (chromeSelected) {
    return (
      <aside
        aria-label={t(M['inspector.title'])}
        className={cn(
          'relative flex shrink-0 flex-col overflow-hidden border-l bg-background',
          open ? 'border-border' : 'border-transparent',
          !resizing && 'transition-[width,border-color] duration-300 ease-out',
        )}
        style={{ width: open ? panelWidth : 0 }}
      >
        <ResizeHandle onResizing={setResizing} />
        <div className="flex min-h-0 flex-1 flex-col" style={{ width: panelWidth }}>
          <PanelHeader name={t(submitSelected ? M['inspector.submit_type'] : M['inspector.form_title_type'])} onClose={closeInspector} />
          <div className="flex-1 overflow-y-auto border-t border-border px-4 py-4">
            <InspectorSection>{submitSelected ? <SubmitInspector /> : <TitleInspector />}</InspectorSection>
          </div>
        </div>
      </aside>
    );
  }

  if (!block || block.type === 'unsupported') return null;

  const tabs = tabsFor(block);
  const shown = tabs.includes(tab) ? tab : (tabs[0] ?? 'logic');
  const typeName = tileOf(block.type, block.config as Readonly<Record<string, unknown>>)?.label ?? block.type;

  return (
    <aside
      aria-label={t(M['inspector.title'])}
      className={cn(
        'relative flex shrink-0 flex-col overflow-hidden border-l bg-background',
        open ? 'border-border' : 'border-transparent',
        !resizing && 'transition-[width,border-color] duration-300 ease-out',
      )}
      style={{ width: open ? panelWidth : 0 }}
    >
      <ResizeHandle onResizing={setResizing} />
      <div className="flex min-h-0 flex-1 flex-col" style={{ width: panelWidth }}>
        <PanelHeader name={blockText(block) || typeName} type={typeName} onClose={closeInspector} />

        <Tabs value={shown} onValueChange={(id) => setTab(id as Tab)} variant="pill" size="sm" className="flex min-h-0 flex-1 flex-col gap-0">
          <TabsList className="mx-4 mb-1 flex w-auto shrink-0">
            {tabs.map((id) => (
              <TabsTrigger key={id} value={id} className="data-[state=active]:text-primary-text">
                {t(TAB_LABELS[id])}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent key={block.id} value={shown} className="flex-1 overflow-y-auto px-4 pb-6 pt-4">
            {shown === 'general' ? <GeneralTab block={block} /> : null}
            {shown === 'design' ? <DesignTab block={block} /> : null}
            {shown === 'logic' ? (
              <InspectorSection>
                <LogicTab blockId={block.id} />
              </InspectorSection>
            ) : null}
          </TabsContent>
        </Tabs>
      </div>
    </aside>
  );
}

/**
 * The panel's title row: the block's own name (its label, or its type when it has none) and, underneath, its type.
 * The type line is left out when it would only repeat the name.
 */
function PanelHeader({ name, type, onClose }: { name: string; type?: string; onClose: () => void }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <h2 className="truncate text-[15px] font-semibold leading-6" title={name}>
          {name}
        </h2>
        {type && type !== name ? <p className="truncate text-[12px] text-muted-foreground">{type}</p> : null}
      </div>
      <Tooltip content={t(M['inspector.close'])}>
        <Button type="button" variant="ghost" size="icon-sm" className="shrink-0" aria-label={t(M['inspector.close'])} onClick={onClose}>
          <X className="size-4" />
        </Button>
      </Tooltip>
    </div>
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

/** Writes part of a block's style; a key set to undefined is removed, and an empty style is dropped. */
function setStyle(block: ShownBlock, patch: { [K in keyof BlockStyle]?: BlockStyle[K] | undefined }): void {
  const next: Record<string, unknown> = { ...block.style, ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  updateBlock(block.id, { style: Object.keys(next).length ? next : undefined });
}

function Colours({ block }: { block: ShownBlock }) {
  const style = block.style ?? {};
  const field = isField(block);
  const inputLook = field && block.type !== 'hidden' && block.type !== 'repeating_group';
  return (
    <>
      <ColorField label={t(field ? M['inspector.label_color'] : M['inspector.text_color'])} value={style.labelColor} fallback="#111111" onChange={(labelColor) => setStyle(block, { labelColor })} />
      {inputLook ? (
        <>
          <ColorField label={t(M['inspector.input_text_color'])} value={style.inputTextColor} fallback="#111111" onChange={(inputTextColor) => setStyle(block, { inputTextColor })} />
          <ColorField label={t(M['inspector.input_bg'])} value={style.inputBg} fallback="#ffffff" onChange={(inputBg) => setStyle(block, { inputBg })} />
          <ColorField label={t(M['inspector.border'])} value={style.borderColor} fallback="#e4e4e7" onChange={(borderColor) => setStyle(block, { borderColor })} />
          <ColorField label={t(M['inspector.placeholder_color'])} value={style.placeholderColor} fallback="#a1a1aa" onChange={(placeholderColor) => setStyle(block, { placeholderColor })} />
        </>
      ) : null}
    </>
  );
}

function WidthField({ block }: { block: ShownBlock }) {
  return (
    <Field label={t(M['inspector.width'])} hint={t(M['inspector.width_hint'])}>
      <ToggleGroup
        type="single"
        size="sm"
        appearance="tinted"
        className="w-full"
        aria-label={t(M['inspector.width'])}
        value={block.layout?.width ?? 'full'}
        onValueChange={(w) => w && setBlockWidth(block.id, w as 'full' | 'half')}
      >
        <ToggleGroupItem value="full" className="flex-1">{t(M['inspector.width_full'])}</ToggleGroupItem>
        <ToggleGroupItem value="half" className="flex-1">{t(M['inspector.width_half'])}</ToggleGroupItem>
      </ToggleGroup>
    </Field>
  );
}

function AlignField({ block }: { block: ShownBlock }) {
  return (
    <Field label={t(M['inspector.align'])}>
      <ToggleGroup
        type="single"
        size="sm"
        appearance="tinted"
        className="w-full"
        aria-label={t(M['inspector.align'])}
        value={block.style?.align ?? 'left'}
        onValueChange={(a) => a && setStyle(block, { align: a === 'left' ? undefined : (a as 'center') })}
      >
        <ToggleGroupItem value="left" className="flex-1">{t(M['inspector.align_left'])}</ToggleGroupItem>
        <ToggleGroupItem value="center" className="flex-1">{t(M['inspector.align_center'])}</ToggleGroupItem>
      </ToggleGroup>
    </Field>
  );
}

/** The question itself, edited here as on the canvas: the same inline editor, so formatting is kept. */
function FieldNameField({ block }: { block: FieldBlock }) {
  return (
    <Field label={t(M['inspector.field_name'])}>
      <div className="rounded-md border border-border px-2 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
        <InlineEditor
          value={block.label}
          onChange={(label) => updateBlock(block.id, { label })}
          placeholder={t(M['inspector.field_name_placeholder'])}
          aria-label={t(M['inspector.field_name'])}
          className="text-[13px] leading-6"
        />
      </div>
    </Field>
  );
}

const FIELD_TYPE_ICON = { required: Asterisk, readOnly: Lock, concealed: EyeOff } as const;
type FieldTypeFlag = keyof typeof FIELD_TYPE_ICON;
const FIELD_TYPE_FLAGS = Object.keys(FIELD_TYPE_ICON) as FieldTypeFlag[];

/**
 * Required, read-only and hidden as one row of toggle tiles: the answers to "what kind of field is this?", visible at
 * a glance. Hidden is PROP-07 `concealed`: the author still sees and edits the field (filled by an admin, a prefill or
 * a default), respondents never see it, and its value is still stored. Unlike a Logic hide, the answer is kept.
 */
function FieldTypeToggles({ block }: { block: FieldBlock }) {
  const on = FIELD_TYPE_FLAGS.filter((flag) => block[flag] === true);
  const label: Record<FieldTypeFlag, string> = {
    required: t(M['inspector.required']),
    readOnly: t(M['inspector.read_only']),
    concealed: t(M['inspector.concealed']),
  };
  return (
    <Field label={t(M['inspector.field_type'])}>
      <ToggleGroup
        type="multiple"
        size="sm"
        appearance="tinted"
        className="w-full"
        aria-label={t(M['inspector.field_type'])}
        value={on}
        onValueChange={(next: string[]) =>
          updateBlock(block.id, {
            required: next.includes('required') || block.primaryKey === true,
            readOnly: next.includes('readOnly') || undefined,
            concealed: next.includes('concealed') || undefined,
          })
        }
      >
        {FIELD_TYPE_FLAGS.map((flag) => {
          const Icon = FIELD_TYPE_ICON[flag];
          return (
            <ToggleGroupItem key={flag} value={flag} aria-label={label[flag]} className="h-auto flex-1 flex-col gap-1 py-2">
              <Icon aria-hidden className={cn('size-3.5', flag === 'required' && 'text-destructive')} />
              {label[flag]}
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      {block.readOnly || block.concealed ? <ReadOnlyValue block={block} /> : null}
      {block.required && (block.concealed || block.readOnly) ? (
        <p role="alert" className="text-[12px] text-amber-700">
          {t(M[block.concealed ? 'inspector.required_concealed' : 'inspector.required_read_only'])}
        </p>
      ) : null}
    </Field>
  );
}

/**
 * Laid out in the order authors decide things: the question, its description and what kind of field it is; the
 * options a respondent picks from; how it reads (the type's own settings, width, label); then what counts as a valid
 * answer. The technical settings (key, custom messages) and the read-only privacy summary stay folded at the end.
 */
function GeneralTab({ block }: { block: ShownBlock }) {
  const field = isField(block);
  const visible = field && block.type !== 'hidden';
  return (
    <>
      {field ? (
        <InspectorSection>
          <FieldNameField block={block} />
          {visible ? (
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
              <FieldTypeToggles block={block} />
            </>
          ) : null}
        </InspectorSection>
      ) : null}
      {sectionOf(block, 'options') ? (
        <InspectorSection title={t(M['inspector.section.options'])}>
          <Registered block={block} section="options" />
        </InspectorSection>
      ) : null}
      <InspectorSection title={t(M['inspector.section.customization'])}>
        <Registered block={block} section="general" />
        {isCompact(block) ? null : <WidthField block={block} />}
        {visible ? <ToggleRow label={t(M['inspector.hide_label'])} checked={block.hideLabel === true} onChange={(on) => updateBlock(block.id, { hideLabel: on || undefined })} /> : null}
      </InspectorSection>
      {field ? (
        <InspectorSection title={t(M['inspector.section.validation'])}>
          <Registered block={block} section="validation" />
          <PrimaryKeySetting block={block} />
          <UniqueSetting block={block} />
          {API_CHECK_TYPES.has(block.type) || block.apiValidation ? <ApiValidationSection block={block} /> : null}
        </InspectorSection>
      ) : null}
      {field ? (
        <InspectorSection title={t(M['inspector.section.advanced'])} collapsible>
          <KeyField block={block} />
          {isCustomFieldType(block.type) ? <SaveAsField block={block} /> : null}
          <ErrorMessages block={block} />
        </InspectorSection>
      ) : null}
      {field ? (
        <InspectorSection title={t(M['inspector.section.privacy'])} collapsible>
          <PrivacySection block={block} />
        </InspectorSection>
      ) : null}
    </>
  );
}

/** How the block looks beyond its content: its alignment and its colours. */
function DesignTab({ block }: { block: ShownBlock }) {
  return (
    <>
      {isCompact(block) ? null : (
        <InspectorSection title={t(M['inspector.section.layout'])}>
          <AlignField block={block} />
        </InspectorSection>
      )}
      <InspectorSection title={t(M['inspector.section.colours'])}>
        <Colours block={block} />
      </InspectorSection>
    </>
  );
}

function SaveAsField({ block }: { block: FieldBlock }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'fail'>('idle');
  const type = block.type;
  if (!isCustomFieldType(type)) return null;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => {
          setName(plainText(block.label) || tileOf(block.type)?.label || block.type);
          setStatus('idle');
          setOpen(true);
        }}
      >
        {t(M['inspector.save_field'])}
      </Button>
      <Dialog open={open} onOpenChange={(next) => { if (status !== 'saving') setOpen(next); }}>
        <DialogContent className="gap-5 p-6 sm:max-w-[440px]">
          <DialogHeader className="space-y-2 pr-6">
            <DialogTitle>{t(M['inspector.save_field_title'])}</DialogTitle>
            <DialogDescription>{t(M['inspector.save_field_help'])}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <TextField label={t(M['inspector.save_field_name'])} value={name} onChange={setName} />
          </div>
          {status === 'fail' ? (
            <p role="alert" className="text-[13px] text-destructive">
              {t(M['inspector.save_field_fail'])}
            </p>
          ) : null}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={status === 'saving'}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={status === 'saving'}
              onClick={() => {
                const config = parseConfig(type, block.config);
                const trimmed = name.trim();
                if (!config || !trimmed) {
                  setStatus('fail');
                  return;
                }
                setStatus('saving');
                saveLibraryField({
                  name: trimmed,
                  icon: tileOf(type)?.icon ?? 'type',
                  keywords: [],
                  baseType: type,
                  config,
                  required: block.required,
                }).then(
                  () => {
                    setOpen(false);
                    setStatus('idle');
                    toast.success(t(M['inspector.save_field_done']));
                  },
                  () => setStatus('fail'),
                );
              }}
            >
              {t(M['inspector.save_field'])}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

const TEXT_DEFAULT = new Set(['short_text', 'long_text', 'email', 'url']);

function ReadOnlyValue({ block }: { block: FieldBlock }) {
  const label = t(M[block.concealed ? 'inspector.concealed_value' : 'inspector.read_only_value']);
  const hint = t(M[block.concealed ? 'inspector.concealed_value_hint' : 'inspector.read_only_value_hint']);
  if (TEXT_DEFAULT.has(block.type)) {
    const config = block.config as { defaultValue?: { kind: string; value: string } };
    const current = config.defaultValue?.kind === 'static' ? config.defaultValue.value : '';
    return (
      <TextField
        label={label}
        hint={hint}
        value={current}
        onChange={(value) => patchBlockConfig(block, { defaultValue: value ? { kind: 'static', value } : undefined })}
      />
    );
  }
  if (block.type === 'number') {
    return (
      <TextField
        label={label}
        hint={hint}
        value={block.config.defaultValue ?? ''}
        onChange={(raw) => {
          const value = /^-?(0|[1-9]\d*)(\.\d{1,10})?$/.test(raw) ? (raw as DecimalString) : undefined;
          patchBlockConfig(block, { defaultValue: raw === '' ? undefined : value ?? block.config.defaultValue });
        }}
      />
    );
  }
  if (block.type === 'date') {
    const current = block.config.defaultValue?.kind === 'fixed' ? block.config.defaultValue.date : '';
    return (
      <TextField
        label={label}
        hint={hint}
        value={current}
        onChange={(date) => patchBlockConfig(block, { defaultValue: /^\d{4}-\d{2}-\d{2}$/.test(date) ? { kind: 'fixed', date } : date === '' ? undefined : block.config.defaultValue })}
      />
    );
  }
  if (block.type === 'time') {
    const current = block.config.defaultValue?.kind === 'fixed' ? block.config.defaultValue.time : '';
    return (
      <TextField
        label={label}
        hint={hint}
        value={current}
        onChange={(time) => patchBlockConfig(block, { defaultValue: /^\d{2}:\d{2}$/.test(time) ? { kind: 'fixed', time } : time === '' ? undefined : block.config.defaultValue })}
      />
    );
  }
  if (block.type === 'rating') {
    return (
      <TextField
        label={label}
        hint={hint}
        value={block.config.defaultValue === undefined ? '' : String(block.config.defaultValue)}
        onChange={(raw) => {
          const n = Number(raw);
          patchBlockConfig(block, { defaultValue: raw === '' ? undefined : Number.isInteger(n) && n >= 1 && n <= block.config.max ? n : block.config.defaultValue });
        }}
      />
    );
  }
  if (block.type === 'single_choice') {
    return (
      <SelectField
        label={label}
        value={block.config.defaultOptionId ?? ''}
        options={[{ value: '', label: '—' }, ...block.config.options.map((option) => ({ value: option.id, label: labelString(option.label) }))]}
        onChange={(id) => patchBlockConfig(block, { defaultOptionId: id ? (id as OptionId) : undefined })}
      />
    );
  }
  return <p className="text-[12px] text-muted-foreground">{hint}</p>;
}

/** Custom texts for refused answers: the empty message shows only once the field is required. */
function ErrorMessages({ block }: { block: FieldBlock }) {
  const formatCode = FORMAT_CODE[block.type];
  const requiredMessage = block.required && block.type !== 'hidden';
  if (!requiredMessage && !formatCode) return null;
  const setMessage = (code: ValidationErrorCode, text: string) => {
    const messages: Partial<Record<ValidationErrorCode, string>> = { ...block.messages };
    if (text) messages[code] = text;
    else delete messages[code];
    updateBlock(block.id, { messages: Object.keys(messages).length ? messages : undefined });
  };
  return (
    <>
      <SectionTitle>{t(M['inspector.section.messages'])}</SectionTitle>
      {requiredMessage ? (
        <TextField label={t(M['inspector.required_message'])} placeholder={t(M['inspector.required_message_placeholder'])} value={block.messages?.required} onChange={(text) => setMessage('required', text)} />
      ) : null}
      {formatCode ? <TextField label={t(M['inspector.format_message'])} value={block.messages?.[formatCode]} onChange={(text) => setMessage(formatCode, text)} /> : null}
    </>
  );
}

/** The unique-answer rule, for the types whose answers can be compared as text. */
/**
 * The one field that identifies a submission. Turning it on makes the field required and unique (and takes the role
 * from any other field); turning it off leaves required and unique as they are, so nothing changes by surprise.
 */
function PrimaryKeySetting({ block }: { block: FieldBlock }) {
  const holder = useDoc((d) => Object.values(d.blocks).find((b): b is FieldBlock => !!b && b.id !== block.id && isField(b) && b.primaryKey === true));
  if (!PRIMARY_KEY_TYPES.has(block.type)) return null;
  const on = block.primaryKey === true;
  return (
    <ToggleRow
      label={t(M['inspector.primary_key'])}
      hint={!on && holder ? `${t(M['inspector.primary_key_hint'])} ${t(M['inspector.primary_key_moved'], { field: blockText(holder) || holder.key })}` : t(M['inspector.primary_key_hint'])}
      checked={on}
      onChange={(next) => {
        if (!next) {
          updateBlock(block.id, { primaryKey: undefined });
          return;
        }
        if (holder) updateBlock(holder.id, { primaryKey: undefined });
        updateBlock(block.id, { primaryKey: true, required: true, unique: block.unique ?? { normalize: defaultNormalize(block.type) } });
      }}
    />
  );
}

function UniqueSetting({ block }: { block: FieldBlock }) {
  if (!UNIQUE_TYPES.has(block.type)) return null;
  const locked = block.primaryKey === true;
  return (
    <>
      <ToggleRow
        label={t(M['inspector.unique'])}
        hint={locked ? t(M['inspector.primary_key_locked']) : t(M['inspector.unique_hint'])}
        disabled={locked}
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
  );
}
