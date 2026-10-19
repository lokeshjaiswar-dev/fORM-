import { useRef } from 'react';
import { rankCount } from '@form/registry';
import type { OptionId } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { useAnswer, useOptions, usePipes, type ControlProps } from './hooks.ts';

/**
 * FLD-23: the options in order, each with move buttons. The answer exists only after the respondent moves one
 * (B8); it holds the top `rankTop` positions.
 */
export function Ranking({ block, field }: ControlProps<'ranking'>) {
  const { t } = useRenderer();
  const { text } = usePipes();
  const answer = useAnswer(block);
  const c = block.config;
  const shown = useOptions(block.id, c.options, c.shuffle === true);
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const ranked = answer.value ?? [];
  const order = [...ranked.filter((id) => shown.some((o) => o.id === id)), ...shown.map((o) => o.id).filter((id) => !ranked.includes(id))];
  const total = order.length;
  const locked = field.disabled || field.readOnly;
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= total) return;
    const next = [...order];
    [next[index], next[to]] = [next[to] as OptionId, next[index] as OptionId];
    answer.set(next.slice(0, rankCount({ ...c, options: shown })));
    const key = `${next[to]}:${by < 0 ? 'up' : 'down'}`;
    requestAnimationFrame(() => (buttons.current.get(key) ?? buttons.current.get(`${next[to]}:${by < 0 ? 'down' : 'up'}`))?.focus());
  };
  const hintId = `${field.ids.base}-hint`;
  return (
    <>
      <p id={hintId} className="fr-hint">{t(MESSAGES['ranking.hint'])}</p>
      <ol className="fr-ranking" aria-describedby={hintId}>
        {order.map((id, i) => {
          const label = text(shown.find((o) => o.id === id)?.label);
          return (
            <li key={id} className="fr-rank">
              <span className="fr-rank-position" aria-hidden="true">{i + 1}</span>
              <span className="fr-rank-label">{label}</span>
              <span className="fr-sr-only">{t(MESSAGES['ranking.position'], { position: i + 1, total })}</span>
              <button
                type="button"
                className="fr-rank-move"
                ref={(el) => void buttons.current.set(`${id}:up`, el)}
                aria-label={t(MESSAGES['ranking.move_up'], { label })}
                disabled={locked || i === 0}
                onClick={() => move(i, -1)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 15l6-6 6 6" /></svg>
              </button>
              <button
                type="button"
                id={i === 0 ? field.ids.input : undefined}
                className="fr-rank-move"
                ref={(el) => void buttons.current.set(`${id}:down`, el)}
                aria-label={t(MESSAGES['ranking.move_down'], { label })}
                disabled={locked || i === total - 1}
                onClick={() => move(i, 1)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6" /></svg>
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}
