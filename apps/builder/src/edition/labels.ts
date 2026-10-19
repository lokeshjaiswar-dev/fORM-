import { defineMessages } from '@form/i18n';
import type { EditionSummary } from '@form/config';
import { t } from '@/i18n';
import type { EditionState } from '@/edition/edition';

const M = defineMessages('builder', {
  'edition.name': 'Edition',
  'edition.saas': 'SaaS',
  'edition.onprem': 'On-premises',
  'edition.allowlist': '{edition} · egress allowlist',
  'edition.airgapped': 'On-premises · air-gapped',
  'edition.unknown': 'Edition unknown',
  'edition.hint.open': 'Integrations, payments and third-party captcha can be used on this installation.',
  'edition.hint.allowlist': 'Only the integrations and payment gateways the operator enabled can be used on this installation.',
  'edition.hint.airgapped': 'Integrations, payments, third-party captcha and analytics are off on this installation.',
  'edition.hint.unknown': 'The server has not answered yet. Features that need the internet are hidden until it does.',
  'edition.hint.cached': '{hint} Last known; the server has not answered yet.',
});

export const editionName = (): string => t(M['edition.name']);

export function editionLabel(summary: EditionSummary | null): string {
  if (!summary) return t(M['edition.unknown']);
  if (summary.airGapped) return t(M['edition.airgapped']);
  const edition = t(summary.deploymentMode === 'saas' ? M['edition.saas'] : M['edition.onprem']);
  return summary.egressPolicy === 'allowlist' ? t(M['edition.allowlist'], { edition }) : edition;
}

export function editionHint({ summary, source }: EditionState): string {
  if (!summary) return t(M['edition.hint.unknown']);
  const hint = t(summary.airGapped ? M['edition.hint.airgapped'] : summary.egressPolicy === 'allowlist' ? M['edition.hint.allowlist'] : M['edition.hint.open']);
  return source === 'cached' ? t(M['edition.hint.cached'], { hint }) : hint;
}
