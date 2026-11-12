import { z } from 'zod';
import { keyed } from './_util.ts';
import {
  SECTION_NAV_CHROMES, SECTION_NAV_COMPLETED, SECTION_NAV_CONNECTORS, SECTION_NAV_CURRENT, SECTION_NAV_MODES, SECTION_NAV_PLACEMENTS, SECTION_NAV_VARIANTS,
} from '../theme.ts';
import {
  AssetRefSchema, BrandRefSchema, FontIdSchema, HexColorSchema, PurposeIdSchema, TemplateIdSchema, TemplateVersionIdSchema, TimeZoneSchema,
} from './primitives.ts';
import { LabelTextSchema, ThemeColorTokenSchema } from './rich-text.ts';

const colorOrBrand = z.union([HexColorSchema, BrandRefSchema]);
const fontOrBrand = z.union([FontIdSchema, BrandRefSchema]);

export const ThemeTokensSchema = z.strictObject({
  colors: keyed(z.partialRecord(ThemeColorTokenSchema, colorOrBrand)),
  typography: z.strictObject({ body: fontOrBrand, heading: fontOrBrand.exactOptional(), baseSizePx: z.number().min(10).max(32) }),
  radius: z.union([z.enum(['none', 'sm', 'md', 'lg', 'full']), BrandRefSchema]),
  density: z.enum(['compact', 'comfortable', 'spacious']),
  formWidth: z.enum(['narrow', 'normal', 'wide']),
  labelAlign: z.enum(['top', 'left', 'right']),
  inputStyle: z.enum(['outlined', 'filled', 'underlined']),
  progress: z.enum(['none', 'bar', 'steps', 'percent']),
  logo: z.strictObject({ image: z.union([AssetRefSchema, BrandRefSchema]), position: z.enum(['left', 'center', 'right']) }).exactOptional(),
  cover: z.strictObject({ image: AssetRefSchema, heightPx: z.number().int().min(40).max(1200) }).exactOptional(),
  background: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('color'), color: colorOrBrand }),
    z.strictObject({ kind: z.literal('gradient'), from: colorOrBrand, to: colorOrBrand, angle: z.number().min(0).max(360) }),
    z.strictObject({ kind: z.literal('image'), image: AssetRefSchema, fit: z.enum(['cover', 'contain', 'tile']) }),
  ]).exactOptional(),
});

export const ThemeSchema = z.strictObject({
  presetRef: z.strictObject({ templateId: TemplateIdSchema, versionId: TemplateVersionIdSchema }).exactOptional(),
  layout: z.enum(['classic', 'cards']),
  tokens: ThemeTokensSchema,
  customCss: z.string().max(50 * 1024).exactOptional(),
});

export const SectionNavSchema = z.strictObject({
  enabled: z.boolean(),
  mode: z.enum(SECTION_NAV_MODES).exactOptional(),
  placement: z.enum(SECTION_NAV_PLACEMENTS),
  variant: z.enum(SECTION_NAV_VARIANTS),
  currentMarker: z.enum(SECTION_NAV_CURRENT),
  completedMarker: z.enum(SECTION_NAV_COMPLETED),
  connector: z.enum(SECTION_NAV_CONNECTORS),
  size: z.enum(['sm', 'md', 'lg']),
  labelSizePx: z.number().int().min(10).max(32).exactOptional(),
  color: HexColorSchema.exactOptional(),
  labelColor: HexColorSchema.exactOptional(),
  sticky: z.boolean(),
  clickable: z.boolean(),
  showIndex: z.boolean(),
  includeSubmit: z.boolean(),
  submitLabel: z.string().max(40).exactOptional(),
  align: z.enum(['start', 'center', 'end']),
  chrome: z.enum(SECTION_NAV_CHROMES).exactOptional(),
});

export const BehaviorSchema = z.strictObject({
  submit: z.strictObject({ label: LabelTextSchema, align: z.enum(['left', 'center', 'right', 'full']), printButton: z.boolean().exactOptional() }),
  navigation: z.strictObject({
    allowBack: z.boolean(),
    showPageTitles: z.boolean(),
    autoAdvance: z.boolean().exactOptional(),
    keyboardShortcuts: z.boolean().exactOptional(),
  }),
  sectionNav: SectionNavSchema.exactOptional(),
  saveAndResume: z.strictObject({
    enabled: z.boolean(),
    showButton: z.boolean(),
    delivery: z.array(z.enum(['email', 'copy_link'])),
    expiryDays: z.number().int().min(1).max(60),
  }),
  localAutosave: z.strictObject({ enabled: z.boolean(), allowWithSensitive: z.boolean() }),
  timeZone: TimeZoneSchema,
  spam: z.strictObject({ honeypot: z.boolean(), minFillSeconds: z.number().min(0).max(3600), captcha: z.enum(['off', 'always', 'on_suspicion']) }),
  analytics: z.strictObject({
    ga4: z.string().max(64).exactOptional(),
    gtm: z.string().max(64).exactOptional(),
    metaPixel: z.string().max(64).exactOptional(),
    requiresPurposeId: PurposeIdSchema,
  }).exactOptional(),
  allowRespondentEdit: z.strictObject({ enabled: z.boolean(), windowHours: z.number().int().min(1).exactOptional() }).exactOptional(),
  urlPrefill: z.boolean(),
  showBranding: z.boolean(),
  a11y: z.strictObject({ announceErrors: z.enum(['polite', 'assertive']), focusFirstError: z.boolean() }),
  successAnimation: z.boolean(),
});
