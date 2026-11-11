import { CONTEXT_SOURCES, type ContextSource } from '@form/schema';
import { defineField, headerOf, isBlank } from '../define.ts';
import { PALETTE_LABELS } from '../messages.ts';
import { TEXT_OPS } from '../operators.ts';
import { NULL, entry, isRootPath } from './shared.ts';

const joined = (value: Partial<Record<string, string>>): string =>
  Object.values(value).map((v) => v?.trim() ?? '').filter(Boolean).join(' · ');

const extraKeys = (config: { urlParams?: string[]; staticFacts?: Array<{ key: string }> }): string[] => [
  ...(config.urlParams ?? []),
  ...(config.staticFacts ?? []).map((f) => f.key),
];

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
    ['session', 'page url', 'referrer', 'browser', 'locale', 'time zone', 'embed', 'started', 'submitted', 'device', 'utm', 'hidden', 'url parameter'],
  )],
  defaultConfig: () => ({ sources: [...CONTEXT_SOURCES], display: 'hidden' }),
  checkConfig: (config, report) => {
    const seen = new Set<ContextSource>();
    config.sources.forEach((source, i) => {
      if (seen.has(source)) report('sources must be unique', ['sources', i]);
      seen.add(source);
    });
    const params = new Set<string>();
    config.urlParams?.forEach((name, i) => {
      if (params.has(name)) report('url params must be unique', ['urlParams', i]);
      params.add(name);
    });
    const keys = new Set<string>();
    config.staticFacts?.forEach((fact, i) => {
      if (keys.has(fact.key)) report('static keys must be unique', ['staticFacts', i]);
      keys.add(fact.key);
    });
    if (config.sources.length === 0 && extraKeys(config).length === 0) report('session details need at least one fact', ['sources']);
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
    utm_source: 'text',
    utm_medium: 'text',
    utm_campaign: 'text',
    utm_term: 'text',
    utm_content: 'text',
  },
  operators: { text: TEXT_OPS },
  toScalar: (value, path) => {
    if (isRootPath(path)) {
      const text = joined(value);
      return text ? { t: 'text', v: text } : NULL;
    }
    const fact = path ? value[path] : undefined;
    return fact ? { t: 'text', v: fact } : NULL;
  },
  isEmpty: (value) => isBlank(value),
  columns: (block) => {
    const header = headerOf(block);
    return [...block.config.sources, ...extraKeys(block.config)].map((source) => ({ suffix: `.${source}`, header: `${header} / ${source}` }));
  },
  cells: (value, block) => [...block.config.sources, ...extraKeys(block.config)].map((source) => value[source] ?? ''),
  text: (value) => joined(value),
  hasDefault: () => true,
});
