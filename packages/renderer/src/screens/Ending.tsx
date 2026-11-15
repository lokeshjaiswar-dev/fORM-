import { useEffect, useRef } from 'react';
import { isSafeUrl, type Ending, type PlainTemplate, type RichDoc } from '@form/schema';
import { Confetti } from '../Confetti.tsx';
import { useRenderer } from '../context.ts';
import { MESSAGES } from '../messages.ts';
import { LINK_REL, RichTextView, type RichTextResolvers } from '../richtext/RichTextView.tsx';

/** A single paragraph is the screen's heading (as the v1 thank-you title was); longer content keeps its blocks. */
function Content({ doc, resolve }: { doc: RichDoc; resolve: RichTextResolvers }) {
  const [first, ...rest] = doc.content;
  if (first?.type === 'paragraph' && rest.length === 0) {
    return <h2 className="fr-screen-title"><RichTextView doc={doc} inline resolve={resolve} /></h2>;
  }
  return <div className="fr-rich"><RichTextView doc={doc} resolve={resolve} /></div>;
}

/**
 * END-01..04 after a submit. Focus moves to the screen so assistive technology announces it; confetti plays only when
 * the form asks for it and the respondent has not asked for reduced motion (DSN-11).
 */
export function EndingScreen({
  ending,
  confetti,
  resolve,
  url,
  redirecting,
  onRestart,
}: {
  ending: Ending;
  confetti: boolean;
  resolve: RichTextResolvers;
  /** A URL template with its piped values percent-encoded. */
  url: (value: PlainTemplate) => string;
  redirecting: boolean;
  onRestart: () => void;
}) {
  const { t } = useRenderer();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const content = ending.kind === 'message' ? ending.content : ending.message;
  return (
    <div ref={ref} className="fr-screen fr-ending" tabIndex={-1}>
      {confetti ? <Confetti /> : null}
      <div className="fr-ending-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" focusable="false"><path d="M20 6 9 17l-5-5" /></svg>
      </div>
      {content ? <Content doc={content} resolve={resolve} /> : null}
      {redirecting ? <p className="fr-hint" role="status">{t(MESSAGES['ending.redirecting'])}</p> : null}
      {ending.kind === 'message'
        ? ending.actions.map((action, i) => {
            if (action.kind === 'fill_again') {
              return (
                <button key={i} type="button" className="fr-button fr-secondary" onClick={onRestart}>
                  {action.label?.trim() || t(MESSAGES['ending.fill_again'])}
                </button>
              );
            }
            if (action.kind === 'visit_url') {
              const href = url(action.url);
              return isSafeUrl(href) ? (
                <a key={i} className="fr-button fr-secondary" href={href} rel={LINK_REL} target="_blank">{action.label}</a>
              ) : null;
            }
            return null;
          })
        : null}
    </div>
  );
}
