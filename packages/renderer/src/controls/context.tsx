import type { ContextSource } from '@form/schema';
import { useRenderer } from '../context.ts';
import { useEvaluation } from '../eval/context.ts';
import { MESSAGES } from '../messages.ts';
import { type ControlProps } from './hooks.ts';

const LABELS = {
  page_url: 'session.page_url',
  referrer: 'session.referrer',
  user_agent: 'session.user_agent',
  started_at: 'session.started_at',
  submitted_at: 'session.submitted_at',
  locale: 'session.locale',
  time_zone: 'session.time_zone',
  embed_origin: 'session.embed_origin',
} as const satisfies Record<ContextSource, keyof typeof MESSAGES>;

/** FLD-31: read-only session facts filled by capture. */
export function ContextField({ block, field }: ControlProps<'context'>) {
  const { t } = useRenderer();
  const { state } = useEvaluation();
  const answer = state.values[block.id];
  const facts = answer?.type === 'context' ? answer.value : {};
  return (
    <output id={field.ids.input} className="fr-input fr-computed fr-session">
      {block.config.sources.map((source) => (
        <span key={source} className="fr-session-row">
          <span className="fr-session-key">{t(MESSAGES[LABELS[source]])}</span>
          <span>{facts[source] ?? '—'}</span>
        </span>
      ))}
    </output>
  );
}
