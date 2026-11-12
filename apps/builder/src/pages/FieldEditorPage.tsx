import { createElement, useEffect, useMemo, useState, type ComponentType } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { defineMessages } from '@form/i18n';
import { TEXT_PRESETS, type TextPreset } from '@form/schema';
import { BUILDER_LOCALE, t } from '@/i18n';
import { Button, Input } from '@dmacq/ui';
import { Field, SectionTitle, SelectField, TextField, ToggleRow } from '@/components/builder/inspector/parts';
import { WorkspaceNav } from '@/components/WorkspaceNav';
import { setConfigSink } from '@/fields/configSink';
import { CUSTOM_FIELD_TYPES, defaultCustomConfig, isCustomFieldType, parseConfig, type CustomField, type CustomFieldType } from '@/fields/custom/model';
import { customFields } from '@/fields/custom/repository';
import { INSPECTOR } from '@/fields/inspector';
import { tileOf } from '@/fields/tiles';
import { blankDefinition, createBlock, type IdSource } from '@/lib/definition';
import { uid } from '@/lib/utils';
import type { BlockOf } from '@form/schema';
import type { AvailableType } from '@form/registry';

const M = defineMessages('builder', {
  'field_editor.new': 'New field',
  'field_editor.edit': 'Edit field',
  'field_editor.name': 'Name',
  'field_editor.name_hint': 'Shown in the palette and on this list',
  'field_editor.type': 'Based on',
  'field_editor.required': 'Required by default',
  'field_editor.keywords': 'Search keywords',
  'field_editor.keywords_hint': 'Comma-separated. Used in the slash menu.',
  'field_editor.preset': 'Input preset',
  'field_editor.preset_none': 'None',
  'field_editor.mask': 'Input mask',
  'field_editor.mask_hint': 'Use # for a digit, @ for a letter, * for either.',
  'field_editor.save': 'Save field',
  'field_editor.missing': 'Field not found',
  'field_editor.back': 'Back to fields',
  'field_editor.config': 'Settings',
  'field_editor.validation': 'Validation',
  'field_editor.options': 'Options',
  'field_editor.invalid': 'Check the settings: {problem}',
  'field_editor.not_saved': 'This field could not be saved in this browser.',
});

const IDS: IdSource = { newId: () => 'library_field' };

type Draft = BlockOf<AvailableType>;

function draftBlock(type: CustomFieldType, config: object): Draft {
  const doc = blankDefinition('library', IDS);
  return createBlock({ type, configOverrides: config }, doc, IDS) as Draft;
}

function withConfig(prev: Draft, patch: Record<string, unknown>): Draft {
  const config: Record<string, unknown> = { ...prev.config, ...patch };
  for (const key of Object.keys(config)) if (config[key] === undefined) delete config[key];
  return { ...prev, config } as Draft;
}

export function FieldEditorPage() {
  const { id = '' } = useParams();
  const creating = id === 'new' || id === '';
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(creating);
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState('');
  const [baseType, setBaseType] = useState<CustomFieldType>('short_text');
  const [required, setRequired] = useState(false);
  const [keywords, setKeywords] = useState('');
  const [block, setBlock] = useState(() => draftBlock('short_text', defaultCustomConfig('short_text', BUILDER_LOCALE)));
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<CustomField | null>(null);

  useEffect(() => {
    if (creating) return;
    let live = true;
    customFields.load(id).then((field) => {
      if (!live) return;
      if (!field) {
        setMissing(true);
        setLoaded(true);
        return;
      }
      setExisting(field);
      setName(field.name);
      setBaseType(field.baseType);
      setRequired(field.required);
      setKeywords(field.keywords.join(', '));
      setBlock(draftBlock(field.baseType, field.config));
      setLoaded(true);
    });
    return () => {
      live = false;
    };
  }, [creating, id]);

  useEffect(() => {
    setConfigSink((_blockId, config) => {
      setBlock((prev) => withConfig(prev, config));
    });
    return () => setConfigSink(null);
  }, []);

  const inspector = INSPECTOR[block.type];
  const typeOptions = useMemo(
    () => CUSTOM_FIELD_TYPES.map((type) => ({ value: type, label: tileOf(type)?.label ?? type })),
    [],
  );

  function changeType(next: string) {
    if (!isCustomFieldType(next)) return;
    setBaseType(next);
    setBlock(draftBlock(next, defaultCustomConfig(next, BUILDER_LOCALE)));
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('name');
      return;
    }
    const config = parseConfig(baseType, block.config);
    if (!config) {
      setError('config');
      return;
    }
    const now = new Date().toISOString();
    const field: CustomField = {
      id: existing?.id ?? uid(),
      name: trimmed,
      icon: tileOf(baseType)?.icon ?? 'type',
      keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
      baseType,
      config,
      required,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    try {
      await customFields.save(field);
    } catch {
      setError('save');
      return;
    }
    navigate('/fields');
  }

  if (!loaded) return <main className="mx-auto w-full max-w-[720px] px-8 pt-[72px]" aria-busy="true" />;
  if (missing) {
    return (
      <main className="mx-auto w-full max-w-[720px] px-8 pt-[72px] text-foreground">
        <h1 className="text-[28px] font-bold">{t(M['field_editor.missing'])}</h1>
        <Link to="/fields" className="mt-6 inline-block text-[14px] text-muted-foreground underline">
          {t(M['field_editor.back'])}
        </Link>
      </main>
    );
  }

  const short = block.type === 'short_text' ? (block.config as { preset?: TextPreset; mask?: { pattern: string; storeMasked: boolean } }) : null;
  const configError = parseConfig(baseType, block.config) ? null : t(M['field_editor.invalid'], { problem: 'invalid settings' });

  return (
    <main className="mx-auto w-full max-w-[720px] px-8 pb-24 pt-[72px] text-foreground">
      <WorkspaceNav />
      <h1 className="text-[40px] font-bold leading-[1.15] tracking-[-0.02em]">{t(creating ? M['field_editor.new'] : M['field_editor.edit'])}</h1>
      <div className="mt-8 space-y-4">
        <TextField label={t(M['field_editor.name'])} hint={t(M['field_editor.name_hint'])} value={name} onChange={setName} error={error === 'name' ? t(M['field_editor.name']) : null} />
        <SelectField label={t(M['field_editor.type'])} value={baseType} options={typeOptions} onChange={changeType} />
        <ToggleRow label={t(M['field_editor.required'])} checked={required} onChange={setRequired} />
        <TextField label={t(M['field_editor.keywords'])} hint={t(M['field_editor.keywords_hint'])} value={keywords} onChange={setKeywords} />

        {inspector.general || inspector.options || inspector.validation || short ? (
          <div className="space-y-3 rounded-[8px] border border-border p-4">
            {inspector.general ? (
              <>
                <SectionTitle>{t(M['field_editor.config'])}</SectionTitle>
                {createElement(inspector.general as ComponentType<{ block: Draft }>, { block })}
              </>
            ) : null}
            {inspector.options ? (
              <>
                <SectionTitle>{t(M['field_editor.options'])}</SectionTitle>
                {createElement(inspector.options as ComponentType<{ block: Draft }>, { block })}
              </>
            ) : null}
            {inspector.validation ? (
              <>
                <SectionTitle>{t(M['field_editor.validation'])}</SectionTitle>
                {createElement(inspector.validation as ComponentType<{ block: Draft }>, { block })}
              </>
            ) : null}
            {short ? (
              <>
                <SelectField
                  label={t(M['field_editor.preset'])}
                  value={short.preset ?? 'none'}
                  options={[{ value: 'none', label: t(M['field_editor.preset_none']) }, ...TEXT_PRESETS.map((preset) => ({ value: preset, label: preset }))]}
                  onChange={(preset) => setBlock((prev) => withConfig(prev, { preset: preset === 'none' ? undefined : preset }))}
                />
                <Field label={t(M['field_editor.mask'])} hint={t(M['field_editor.mask_hint'])}>
                  <Input
                    value={short.mask?.pattern ?? ''}
                    onChange={(e) => {
                      const pattern = e.target.value;
                      setBlock((prev) => withConfig(prev, { mask: pattern ? { pattern, storeMasked: false } : undefined }));
                    }}
                  />
                </Field>
              </>
            ) : null}
            {configError ? (
              <p role="alert" className="text-[12px] text-destructive">
                {configError}
              </p>
            ) : null}
          </div>
        ) : null}

        {error === 'save' ? (
          <p role="alert" className="text-[14px] text-destructive">
            {t(M['field_editor.not_saved'])}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button type="button" onClick={() => void save()}>
            {t(M['field_editor.save'])}
          </Button>
          <Button type="button" variant="outline" onClick={() => navigate('/fields')}>
            {t(M['field_editor.back'])}
          </Button>
        </div>
      </div>
    </main>
  );
}
