import type { CardBucketId, CardItemId } from '@form/schema';
import { defineField, headerOf } from '../define.ts';
import { DEFAULT_TEXT, PALETTE_LABELS, message } from '../messages.ts';
import { PRESENCE_OPS } from '../operators.ts';
import { NULL, countScalar, entry, isRootPath } from './shared.ts';

/** Closed card sort: each item is placed in a bucket. */
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
    const used = new Map<CardBucketId, number>();
    for (const [itemId, bucketId] of Object.entries(value) as Array<[CardItemId, CardBucketId | undefined]>) {
      if (bucketId === undefined) continue;
      if (!itemIds.has(itemId)) report('not_in_options', [itemId]);
      if (!bucketIds.has(bucketId)) report('not_in_options', [itemId]);
      used.set(bucketId, (used.get(bucketId) ?? 0) + 1);
    }
    if (state.required && block.config.items.some((i) => value[i.id] === undefined)) report('too_few_selected');
  },
  paths: { '': 'choices' },
  operators: { choices: PRESENCE_OPS },
  toScalar: (value, path) => (isRootPath(path) ? countScalar(Object.values(value).filter(Boolean).length) : NULL),
  isEmpty: (value) => Object.values(value).every((id) => id === undefined),
  columns: (block) => block.config.items.map((item) => ({ suffix: `.${item.id}`, header: `${headerOf(block)} ${item.label}` })),
  cells: (value, block) => block.config.items.map((item) => {
    const bucketId = value[item.id];
    return bucketId === undefined ? '' : (block.config.buckets.find((b) => b.id === bucketId)?.label ?? bucketId);
  }),
  texts: (block) => [
    ...block.config.items.map((i) => `mrow:${block.id}/${i.id}` as const),
    ...block.config.buckets.map((b) => `mcol:${block.id}/${b.id}` as const),
  ],
  content: () => ['/config/items', '/config/buckets'],
});
