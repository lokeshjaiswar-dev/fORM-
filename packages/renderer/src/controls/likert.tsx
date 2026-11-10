import type { LikertStatementId } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, range, useAnswer, type ControlProps } from './hooks.ts';

/** Radio scale per statement; unanswered statements stay empty (B7). */
export function LikertField({ block, field }: ControlProps<'likert'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const scores = answer.value ?? {};
  const points = range(block.config.min, Math.min(10, Math.max(block.config.min + 1, block.config.max)));
  const attrs = inputAttrs(field);

  const setScore = (id: LikertStatementId, score: number) => {
    answer.set({ ...scores, [id]: score });
  };

  return (
    <div className="fr-likert-wrap">
      <table className="fr-likert">
        <thead>
          <tr>
            <th />
            {points.map((n) => (
              <th key={n}>{n === block.config.min && block.config.lowLabel ? `${n} · ${block.config.lowLabel}` : n === block.config.max && block.config.highLabel ? `${n} · ${block.config.highLabel}` : n}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.config.statements.map((stmt, ri) => (
            <tr key={stmt.id}>
              <th scope="row">{stmt.label}</th>
              {points.map((n, ci) => (
                <td key={n}>
                  <input
                    id={ri === 0 && ci === 0 ? field.ids.input : undefined}
                    type="radio"
                    name={`${field.ids.base}-${stmt.id}`}
                    aria-label={t(MESSAGES['likert.point'], { statement: stmt.label, value: n, max: block.config.max })}
                    checked={scores[stmt.id] === n}
                    onChange={() => setScore(stmt.id, n)}
                    onBlur={answer.onBlur}
                    {...attrs}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
