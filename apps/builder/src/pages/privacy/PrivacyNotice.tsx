import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import type { PlatformNotice } from '@/auth/client';
import { cn } from '@/lib/utils';

const M = defineMessages('builder', {
  'notice.version': 'Version {version}',
});

/** The notice as text: a heading per section, its paragraphs and its list. Never HTML from the server. */
export function PrivacyNotice({ notice, headingLevel = 2, className }: { notice: PlatformNotice; headingLevel?: 2 | 3; className?: string }) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className={cn('space-y-4 text-[13px] leading-relaxed text-zinc-800', className)}>
      <p className="text-[12px] text-[var(--notion-text-muted)]">{t(M['notice.version'], { version: notice.version })}</p>
      {notice.sections.map((s) => (
        <section key={s.id} aria-labelledby={`notice-${s.id}`}>
          <Heading id={`notice-${s.id}`} className="mb-1 text-[14px] font-semibold text-zinc-900">
            {s.heading}
          </Heading>
          {s.paragraphs.map((p) => (
            <p key={p} className="mb-1.5">
              {p}
            </p>
          ))}
          {s.items.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5">
              {s.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}
    </div>
  );
}
