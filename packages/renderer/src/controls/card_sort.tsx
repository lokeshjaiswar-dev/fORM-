import type { CardBucketId, CardItemId } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

/** Place each item into a bucket. */
export function CardSortField({ block, field }: ControlProps<'card_sort'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const placed = answer.value ?? {};
  const attrs = inputAttrs(field);

  const setBucket = (itemId: CardItemId, bucketId: CardBucketId | '') => {
    const next = { ...placed };
    if (bucketId === '') delete next[itemId];
    else next[itemId] = bucketId;
    answer.set(Object.keys(next).length === 0 ? undefined : next);
  };

  return (
    <div className="fr-cardsort">
      {block.config.items.map((item, i) => (
        <div key={item.id} className="fr-cardsort-row">
          <label className="fr-label" htmlFor={i === 0 ? field.ids.input : `${field.ids.base}-${item.id}`}>{item.label}</label>
          <select
            id={i === 0 ? field.ids.input : `${field.ids.base}-${item.id}`}
            className="fr-input"
            value={placed[item.id] ?? ''}
            onChange={(e) => setBucket(item.id, e.target.value as CardBucketId | '')}
            onBlur={answer.onBlur}
            {...attrs}
          >
            <option value="">{t(MESSAGES['card_sort.pick'])}</option>
            {block.config.buckets.map((bucket) => (
              <option key={bucket.id} value={bucket.id}>{bucket.label}</option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}
