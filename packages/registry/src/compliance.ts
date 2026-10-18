import type { DataCategory, FieldCompliance, PurposeId, ValueFieldType } from '@form/schema';

/*
 * CMP-03 registry defaults. Purposes are form-specific, so every default starts with none; the builder
 * and migration attach the form's purposes. The objects are frozen: copy before editing.
 */

const freeze = (compliance: FieldCompliance): FieldCompliance => {
  Object.freeze(compliance.purposeIds);
  return Object.freeze(compliance);
};

const noPurposes = (): PurposeId[] => [];

const none = (): FieldCompliance => freeze({
  classification: 'none',
  purposeIds: noPurposes(),
  encrypt: false,
  allowPrefill: true,
  inNotifications: 'include',
  inExports: 'include',
});

const personal = (category: DataCategory, extra: Pick<FieldCompliance, 'principalIdentifier'> | { allowPrefill: false } = {}): FieldCompliance => freeze({
  classification: 'personal',
  category,
  purposeIds: noPurposes(),
  encrypt: false,
  allowPrefill: true,
  inNotifications: 'include',
  inExports: 'include',
  ...extra,
});

export const DEFAULT_COMPLIANCE: { readonly [T in ValueFieldType]: FieldCompliance } = {
  short_text: personal('free_text'),
  long_text: personal('free_text'),
  full_name: personal('identity'),
  email: personal('contact', { principalIdentifier: 'email' }),
  phone: personal('contact'),
  address: personal('location'),
  number: none(),
  url: personal('free_text'),
  single_choice: none(),
  multi_choice: none(),
  date: none(),
  datetime: none(),
  time: none(),
  rating: none(),
  linear_scale: none(),
  nps: none(),
  ranking: none(),
  matrix: none(),
  repeating_group: none(),
  file_upload: personal('other', { allowPrefill: false }),
  signature: personal('identity', { allowPrefill: false }),
  hidden: none(),
  consent: personal('other', { allowPrefill: false }),
  payment: personal('financial', { allowPrefill: false }),
  appointment: personal('other'),
  calculation: none(),
  context: personal('device'),
  unique_id: none(),
};

/** Defaults a privacy reviewer still has to confirm: a hidden field captures whatever the URL carries. */
export const COMPLIANCE_UNDER_REVIEW: readonly ValueFieldType[] = Object.freeze(['hidden']);
