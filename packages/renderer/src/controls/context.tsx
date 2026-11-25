import type { ContextSource } from '@form/schema';
import { useRenderer } from '../context.ts';
import { useEvaluation } from '../eval/context.ts';
import { MESSAGES } from '../messages.ts';
import { toWallDateTime } from './appointmentSlots.ts';
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
  utm_source: 'session.utm_source',
  utm_medium: 'session.utm_medium',
  utm_campaign: 'session.utm_campaign',
  utm_term: 'session.utm_term',
  utm_content: 'session.utm_content',
} as const satisfies Record<ContextSource, keyof typeof MESSAGES>;

function sessionValue(source: string, raw: string | undefined, formatInstant: (value: string) => string): string {
  if (!raw) return '—';
  if (source === 'started_at' || source === 'submitted_at') return formatInstant(raw) || raw;
  return raw;
}

function factLabel(source: string, t: (id: (typeof MESSAGES)[keyof typeof MESSAGES]) => string): string {
  return source in LABELS ? t(MESSAGES[LABELS[source as ContextSource]]) : source;
}

/** FLD-31: read-only session facts filled by capture. */
export function ContextField({ block, field }: ControlProps<'context'>) {
  const { t, i18n, meta } = useRenderer();
  const { state } = useEvaluation();
  const answer = state.values[block.id];
  const facts = answer?.type === 'context' ? answer.value : {};
  const keys = [...block.config.sources, ...(block.config.urlParams ?? []), ...(block.config.staticFacts ?? []).map((f) => f.key)];
  const formatInstant = (value: string) => {
    const local = toWallDateTime(value, meta.timeZone);
    return local ? i18n.formatDateTime(local, 'D MMM YYYY', 'h12') : '';
  };
  return (
    <output id={field.ids.input} className="fr-session-card">
      <span className="fr-session-head">
        <span className="fr-session-title">{t(MESSAGES['session.title'])}</span>
      </span>
      {keys.length === 0 ? <p className="fr-session-empty">{t(MESSAGES['session.empty'])}</p> : (
        <span className="fr-session-list">
          {keys.map((source) => (
            <span key={source} className="fr-session-row">
              <span className="fr-session-key">{factLabel(source, t)}</span>
              <span>{sessionValue(source, facts[source], formatInstant)}</span>
            </span>
          ))}
        </span>
      )}
    </output>
  );
}
