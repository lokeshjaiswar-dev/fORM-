import type { ConsentItemId, Locale, RichDoc } from '@form/schema';
import { useRenderer } from '../context.ts';
import { RichTextView } from '../richtext/RichTextView.tsx';
import { inputAttrs, useAnswer, usePipes, type ControlProps } from './hooks.ts';

function hasNoticeText(doc: RichDoc): boolean {
  const walk = (nodes: unknown[]): boolean => nodes.some((node) => {
    if (!node || typeof node !== 'object') return false;
    const n = node as { text?: string; content?: unknown[] };
    if (typeof n.text === 'string' && n.text.trim()) return true;
    return Array.isArray(n.content) && walk(n.content);
  });
  return walk(doc.content ?? []);
}

/** FLD-36: notice plus one checkbox per consent item. Scroll-to-agree marks scrolledToEnd when the notice is scrolled. */
export function ConsentField({ block, field }: ControlProps<'consent'>) {
  const { i18n } = useRenderer();
  const { resolve } = usePipes();
  const answer = useAnswer(block);
  const attrs = inputAttrs(field);
  const items = answer.value?.items ?? {};
  const locale = (answer.value?.noticeLocale ?? i18n.locale) as Locale;
  const write = (next: typeof items, scrolledToEnd?: boolean) => {
    const granted = Object.values(next).some((v) => v !== undefined);
    answer.set(granted || scrolledToEnd
      ? { items: next, noticeLocale: locale, noticeVersion: block.config.noticeVersion, ...(scrolledToEnd ? { scrolledToEnd: true } : {}) }
      : undefined);
  };
  return (
    <div className="fr-consent">
      {hasNoticeText(block.config.notice) ? (
        <div
          className="fr-consent-notice fr-rich"
          onScroll={(e) => {
            if (block.config.presentation !== 'scroll_to_agree') return;
            const el = e.currentTarget;
            if (el.scrollTop + el.clientHeight >= el.scrollHeight - 8) write(items, true);
          }}
        >
          <RichTextView doc={block.config.notice} resolve={resolve} />
        </div>
      ) : null}
      {block.config.items.map((item, i) => {
        const id = `${field.ids.input}-${item.id}`;
        return (
          <label key={item.id} className="fr-consent-item" htmlFor={id}>
            <input
              id={i === 0 ? field.ids.input : id}
              type="checkbox"
              checked={items[item.id] === true}
              onChange={(e) => write({ ...items, [item.id as ConsentItemId]: e.target.checked })}
              onBlur={answer.onBlur}
              {...attrs}
            />
            <span className="fr-rich"><RichTextView doc={item.label} inline resolve={resolve} /></span>
          </label>
        );
      })}
    </div>
  );
}
