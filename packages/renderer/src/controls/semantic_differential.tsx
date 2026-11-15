import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, range, useAnswer, type ControlProps } from './hooks.ts';

/** Radio scale between two adjective poles per pair. */
export function SemanticDifferentialField({ block, field }: ControlProps<'semantic_differential'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const scores = answer.value ?? {};
  const points = range(block.config.min, Math.min(10, Math.max(block.config.min + 1, block.config.max)));
  const attrs = inputAttrs(field);

  return (
    <div className="fr-semantic-wrap">
      <table className="fr-semantic">
        <thead>
          <tr>
            <th />
            {points.map((n) => (
              <th key={n}>{n}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {block.config.pairs.map((pair, ri) => (
            <tr key={pair.id}>
              <th scope="row">{pair.left}</th>
              {points.map((n, ci) => (
                <td key={n}>
                  <input
                    id={ri === 0 && ci === 0 ? field.ids.input : undefined}
                    type="radio"
                    name={`${field.ids.base}-${pair.id}`}
                    aria-label={t(MESSAGES['semantic.point'], { left: pair.left, right: pair.right, value: n, max: block.config.max })}
                    checked={scores[pair.id] === n}
                    onChange={() => answer.set({ ...scores, [pair.id]: n } as typeof scores)}
                    onBlur={answer.onBlur}
                    {...attrs}
                  />
                </td>
              ))}
              <th scope="row">{pair.right}</th>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
