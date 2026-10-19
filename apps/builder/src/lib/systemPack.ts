import type { FormId, InstantiateContext, IsoInstant, Locale } from '@form/schema';
import { DEV_TRUSTED_KEY, fromBase64, packTemplateVersion, readFormpack, type Formpack, type FormpackTemplate } from '@form/templates';
import { instantiate } from '@form/templates-core';
import packDataUrl from '@form/templates/packs/system-core-2026.10.0.formpack?inline';
import { v1FromV2 } from '@/lib/v1FromV2';
import type { FormSchema } from '@/types/form';

/*
 * The system-core pack `pnpm templates:build` signs, bundled into the builder (no network): the New-form gallery reads
 * it with `readFormpack` and makes a form with `instantiate()`, as the API will (WP-T1.4).
 */

export const GALLERY_LOCALE = 'en-IN' as Locale;

let loaded: Promise<Formpack> | null = null;

/** Verifies and parses the bundled pack once. */
export function loadSystemPack(): Promise<Formpack> {
  loaded ??= readFormpack(fromBase64(packDataUrl.slice(packDataUrl.indexOf(',') + 1)), { trustedKeys: [DEV_TRUSTED_KEY] }).catch((e: unknown) => {
    loaded = null;
    throw e;
  });
  return loaded;
}

export interface UseTemplate { idSeed: string; bindingIdSeed: string; now: IsoInstant }

/**
 * A new form from a pack template, offline: `instantiate()` with the template's defaults (the Use dialog is WP-0.11b),
 * shown through the v1 store. `idSeed` plays the Idempotency-Key the API will take for the same use.
 */
export function formFromTemplate(pack: Formpack, template: FormpackTemplate, use: UseTemplate): { form: FormSchema; skipped: number } {
  const ctx: InstantiateContext = {
    newFormId: 'draft' as FormId,
    idSeed: use.idSeed,
    bindingIdSeed: use.bindingIdSeed,
    locale: GALLERY_LOCALE,
    extraLocales: [],
    orgProfile: null,
    brandKit: null,
    variables: {},
    include: { theme: true, emails: true, endings: true, pdf: true, workflow: true },
    now: use.now,
  };
  return v1FromV2(instantiate(packTemplateVersion(pack, template, use.now), ctx).definition);
}
