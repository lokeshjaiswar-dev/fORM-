import type { FormDefinition, FormId, InstantiateContext, IsoInstant, TemplateVariableName, TemplateWarning } from '@form/schema';
import { DEV_TRUSTED_KEY, fromBase64, packTemplateVersion, readFormpack, type Formpack, type FormpackTemplate } from '@form/templates';
import { instantiate } from '@form/templates-core';
import packDataUrl from '@form/templates/packs/system-core-2026.10.0.formpack?inline';
import { BUILDER_LOCALE } from '@/i18n';

/*
 * The system-core pack `pnpm templates:build` signs, bundled into the builder (no network): the New-form gallery reads
 * it with `readFormpack` and makes a v2 definition with `instantiate()`, as the API will (WP-T1.4). Only the gallery
 * imports this module, and it is loaded on demand, so the pack stays out of the main chunk (BL-123).
 */

export const GALLERY_LOCALE = BUILDER_LOCALE;

let loaded: Promise<Formpack> | null = null;

/** Verifies and parses the bundled pack once; a failure is not cached, so the next call tries again. */
export function loadSystemPack(): Promise<Formpack> {
  loaded ??= readFormpack(fromBase64(packDataUrl.slice(packDataUrl.indexOf(',') + 1)), { trustedKeys: [DEV_TRUSTED_KEY] }).catch((e: unknown) => {
    loaded = null;
    throw e;
  });
  return loaded;
}

export type VariableAnswers = Partial<Record<TemplateVariableName, string | number | boolean>>;

export interface UseTemplate {
  /** Plays the Idempotency-Key the API will take for the same use: the same seed gives the same ids. */
  idSeed: string;
  bindingIdSeed: string;
  now: IsoInstant;
  /** The Use dialog's answers to the template's prompt variables (optional parts follow their boolean variables). */
  variables?: VariableAnswers;
}

/** A new v2 form from a pack template, offline: `instantiate()` with the Use dialog's answers. */
export function formFromTemplate(pack: Formpack, template: FormpackTemplate, use: UseTemplate): { definition: FormDefinition; warnings: TemplateWarning[] } {
  const ctx: InstantiateContext = {
    newFormId: 'draft' as FormId,
    idSeed: use.idSeed,
    bindingIdSeed: use.bindingIdSeed,
    locale: GALLERY_LOCALE,
    extraLocales: [],
    orgProfile: null,
    brandKit: null,
    variables: use.variables ?? {},
    include: { theme: true, emails: true, endings: true, pdf: true, workflow: true },
    now: use.now,
  };
  const result = instantiate(packTemplateVersion(pack, template, use.now), ctx);
  return { definition: result.definition, warnings: result.warnings };
}
