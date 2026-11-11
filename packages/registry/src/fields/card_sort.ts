import type { CardBucketId, CardItemId } from '@form/schema';
import { defineField, headerOf } from '../define.ts';
import { DEFAULT_TEXT, PALETTE_LABELS, message } from '../messages.ts';
import { PRESENCE_OPS } from '../operators.ts';
import { NULL, countScalar, entry, isRootPath, pairLines } from './shared.ts';

const asBuckets = (value: CardBucketId | CardBucketId[] | undefined): CardBucketId[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const bucketLabel = (buckets: ReadonlyArray<{ id: CardBucketId; label: string }>, id: CardBucketId): string =>
  buckets.find((b) => b.id === id)?.label ?? id;

/** Closed card sort: each item is placed in a bucket, or several when exclusive is off. */
export const cardSort = defineField({
  type: 'card_sort',
  palette: [entry('card_sort', null, 'choice', PALETTE_LABELS['palette.card_sort'], 'columns-3', ['card sort', 'buckets', 'categorise', 'group', 'classify'])],
  defaultConfig: (locale) => ({
    items: [1, 2, 3, 4].map((n) => ({ id: `item_${n}` as CardItemId, label: message(locale, DEFAULT_TEXT['defaults.card_item'], { n }) })),
    buckets: [1, 2, 3].map((n) => ({ id: `bucket_${n}` as CardBucketId, label: message(locale, DEFAULT_TEXT['defaults.card_bucket'], { n }) })),
    exclusive: true,
  }),
  checkConfig: (config, report) => {
    const items = new Set<string>();
    config.items.forEach((item, i) => {
      if (items.has(item.id)) report('item ids must be unique', ['items', i, 'id']);
      items.add(item.id);
    });
    const buckets = new Set<string>();
    config.buckets.forEach((bucket, i) => {
      if (buckets.has(bucket.id)) report('bucket ids must be unique', ['buckets', i, 'id']);
      buckets.add(bucket.id);
    });
  },
  checkAnswer: (value, block, state, report) => {
    const itemIds = new Set(block.config.items.map((i) => i.id));
    const bucketIds = new Set(block.config.buckets.map((b) => b.id));
    for (const [itemId, raw] of Object.entries(value) as Array<[CardItemId, CardBucketId | CardBucketId[] | undefined]>) {
      const picked = asBuckets(raw);
      if (picked.length === 0) continue;
      if (!itemIds.has(itemId)) report('not_in_options', [itemId]);
      if (block.config.exclusive && picked.length > 1) report('too_many_selected', [itemId]);
      const seen = new Set<CardBucketId>();
      const listed = Array.isArray(raw);
      picked.forEach((bucketId, i) => {
        const at = listed ? [itemId, i] : [itemId];
        if (!bucketIds.has(bucketId)) report('not_in_options', at);
        else if (seen.has(bucketId)) report('invalid_format', at);
        seen.add(bucketId);
      });
    }
    if (state.required && block.config.items.some((i) => asBuckets(value[i.id]).length === 0)) report('too_few_selected');
  },
  paths: { '': 'choices' },
  operators: { choices: PRESENCE_OPS },
  toScalar: (value, path) => (isRootPath(path) ? countScalar(Object.values(value).filter((v) => asBuckets(v as CardBucketId | CardBucketId[] | undefined).length > 0).length) : NULL),
  isEmpty: (value) => Object.values(value).every((id) => asBuckets(id as CardBucketId | CardBucketId[] | undefined).length === 0),
  columns: (block) => block.config.items.map((item) => ({ suffix: `.${item.id}`, header: `${headerOf(block)} ${item.label}` })),
  cells: (value, block) => block.config.items.map((item) => asBuckets(value[item.id]).map((id) => bucketLabel(block.config.buckets, id)).join(', ')),
  text: (value, block) => pairLines(block.config.items.map((item) => [item.label, asBuckets(value[item.id]).map((id) => bucketLabel(block.config.buckets, id)).join(', ')] as const)),
  texts: (block) => [
    ...block.config.items.map((i) => `mrow:${block.id}/${i.id}` as const),
    ...block.config.buckets.map((b) => `mcol:${block.id}/${b.id}` as const),
  ],
  content: () => ['/config/items', '/config/buckets'],
});
