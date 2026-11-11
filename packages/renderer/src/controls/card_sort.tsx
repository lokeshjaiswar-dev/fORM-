import type { CardBucketId, CardItemId } from '@form/schema';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { DsMultiSelect, DsSelect } from './ds.tsx';
import { inputAttrs, useAnswer, type ControlProps } from './hooks.ts';

const asBuckets = (value: CardBucketId | CardBucketId[] | undefined): CardBucketId[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Place each item into a bucket, or several buckets when exclusive is off. */
export function CardSortField({ block, field }: ControlProps<'card_sort'>) {
  const { t } = useRenderer();
  const answer = useAnswer(block);
  const placed = answer.value ?? {};
  const attrs = inputAttrs(field);
  const exclusive = block.config.exclusive;
  const bucketOptions = block.config.buckets.map((bucket) => ({ value: bucket.id, label: bucket.label }));

  const write = (itemId: CardItemId, buckets: CardBucketId[]) => {
    const next = { ...placed };
    if (buckets.length === 0) delete next[itemId];
    else next[itemId] = exclusive ? buckets[0]! : buckets;
    answer.set(Object.keys(next).length === 0 ? undefined : next);
  };

  return (
    <div className="fr-cardsort">
      {block.config.items.map((item, i) => {
        const chosen = asBuckets(placed[item.id]);
        const id = i === 0 ? field.ids.input : `${field.ids.base}-${item.id}`;
        return (
          <div key={item.id} className="fr-cardsort-row">
            <label className="fr-label" htmlFor={id}>{item.label}</label>
            {exclusive ? (
              <DsSelect
                id={id}
                value={chosen[0] ?? ''}
                onChange={(value) => write(item.id, value === '' ? [] : [value as CardBucketId])}
                onBlur={answer.onBlur}
                options={bucketOptions}
                placeholder={t(MESSAGES['card_sort.pick'])}
                disabled={attrs.disabled}
                aria-invalid={attrs['aria-invalid']}
                aria-describedby={attrs['aria-describedby']}
                aria-required={attrs['aria-required']}
              />
            ) : (
              <DsMultiSelect
                id={id}
                value={chosen}
                onChange={(value) => write(item.id, value as CardBucketId[])}
                options={bucketOptions}
                placeholder={t(MESSAGES['card_sort.pick_many'])}
                disabled={attrs.disabled}
                aria-invalid={attrs['aria-invalid']}
                aria-describedby={attrs['aria-describedby']}
                aria-required={attrs['aria-required']}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
