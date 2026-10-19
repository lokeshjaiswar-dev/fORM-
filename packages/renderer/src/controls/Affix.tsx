import type { ReactNode } from 'react';

export function Affix({ prefix, suffix, children }: { prefix?: string | undefined; suffix?: string | undefined; children: ReactNode }) {
  if (!prefix && !suffix) return children;
  return (
    <div className="fr-affix">
      {prefix ? <span className="fr-affix-text">{prefix}</span> : null}
      {children}
      {suffix ? <span className="fr-affix-text">{suffix}</span> : null}
    </div>
  );
}
