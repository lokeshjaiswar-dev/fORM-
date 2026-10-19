import { defineMessages, type MessageId } from '@form/i18n';
import type { FieldBlock } from '@form/schema';
import { t } from '@/i18n';
import { useDoc } from '@/state/documentStore';

const M = defineMessages('builder', {
  'privacy.classification': 'Classification',
  'privacy.class_none': 'Not personal data',
  'privacy.class_personal': 'Personal data',
  'privacy.class_sensitive': 'Sensitive personal data',
  'privacy.category': 'Category',
  'privacy.purposes': 'Purposes',
  'privacy.no_purpose': 'No purpose',
  'privacy.encrypted': 'Encrypted at rest',
  'privacy.yes': 'Yes',
  'privacy.no': 'No',
  'privacy.notifications': 'In notification emails',
  'privacy.exports': 'In exports',
  'privacy.include': 'Included',
  'privacy.mask': 'Masked',
  'privacy.omit': 'Left out',
  'privacy.p1': 'Each field takes the registry’s default protection and the form’s purposes. Choosing purposes per field arrives with the purpose picker (Phase 1).',
});

const CLASS: Record<FieldBlock['compliance']['classification'], MessageId> = {
  none: M['privacy.class_none'],
  personal: M['privacy.class_personal'],
  sensitive: M['privacy.class_sensitive'],
};

const SHARE: Record<'include' | 'mask' | 'omit', MessageId> = { include: M['privacy.include'], mask: M['privacy.mask'], omit: M['privacy.omit'] };

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[13px]">
      <dt className="text-[var(--notion-text-muted)]">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

/** The Privacy section: what the field's compliance says (CMP-03), read-only until the P1 purpose picker. */
export function PrivacySection({ block }: { block: FieldBlock }) {
  const purposes = useDoc((d) => d.privacy.purposes);
  const c = block.compliance;
  const names = c.purposeIds.map((id) => purposes.find((p) => p.id === id)?.name ?? id);
  return (
    <div className="space-y-3">
      <dl className="space-y-2">
        <Row label={t(M['privacy.classification'])} value={t(CLASS[c.classification])} />
        {c.category ? <Row label={t(M['privacy.category'])} value={c.category.replaceAll('_', ' ')} /> : null}
        <Row label={t(M['privacy.purposes'])} value={names.length ? names.join(', ') : t(M['privacy.no_purpose'])} />
        <Row label={t(M['privacy.encrypted'])} value={t(c.encrypt ? M['privacy.yes'] : M['privacy.no'])} />
        <Row label={t(M['privacy.notifications'])} value={t(SHARE[c.inNotifications])} />
        <Row label={t(M['privacy.exports'])} value={t(SHARE[c.inExports])} />
      </dl>
      <p className="text-[12px] leading-relaxed text-[var(--notion-text-muted)]">{t(M['privacy.p1'])}</p>
    </div>
  );
}
