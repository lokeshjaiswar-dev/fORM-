import { CONTEXT_SOURCES, type ContextSource } from '@form/schema';
import { defineField, headerOf, isBlank } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const joined = (value: Partial<Record<ContextSource, string>>): string =>
  CONTEXT_SOURCES.map((source) => value[source]?.trim() ?? '').filter(Boolean).join(' · ');

/** FLD-31. Session facts (page URL, referrer, locale, clock) captured on the client, never a third-party pixel. */
export const context = defineField({
  type: 'context',
  kind: 'computed',
  palette: [entry(
    'context',
    null,
    'advanced',
    PALETTE_LABELS['palette.context'],
    'globe',
    ['session', 'page url', 'referrer', 'browser', 'locale', 'time zone', 'embed', 'started', 'submitted', 'device'],
  )],
  defaultConfig: () => ({ sources: [...CONTEXT_SOURCES] }),
  checkConfig: (config, report) => {
    const seen = new Set<ContextSource>();
    config.sources.forEach((source, i) => {
      if (seen.has(source)) report('sources must be unique', ['sources', i]);
      seen.add(source);
    });
  },
  paths: {
    '': 'text',
    page_url: 'text',
    referrer: 'text',
    user_agent: 'text',
    started_at: 'text',
    submitted_at: 'text',
    locale: 'text',
    time_zone: 'text',
    embed_origin: 'text',
  },
  operators: { text: TEXT_OPS },
  toScalar: (value, path) => {
    if (isRootPath(path)) {
      const text = joined(value);
      return text ? { t: 'text', v: text } : NULL;
    }
    const fact = value[path as ContextSource];
    return fact ? { t: 'text', v: fact } : NULL;
  },
  isEmpty: (value) => isBlank(value),
  columns: (block) => {
    const header = headerOf(block);
    return block.config.sources.map((source) => ({ suffix: `.${source}`, header: `${header} / ${source}` }));
  },
  cells: (value, block) => block.config.sources.map((source) => value[source] ?? ''),
  text: (value) => joined(value),
  hasDefault: () => true,
});
