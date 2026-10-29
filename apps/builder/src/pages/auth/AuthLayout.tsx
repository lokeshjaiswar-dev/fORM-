import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { EditionBadge } from '@/edition/EditionBadge';
import { cn } from '@/lib/utils';

const M = defineMessages('builder', {
  'auth.brand': 'fORM-',
});

/** The centred card every sign-in page uses; `wide` for the account pages with longer text (privacy). */
export function AuthLayout({
  title,
  description,
  children,
  footer,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <main className={cn('flex min-h-screen items-start justify-center bg-[var(--notion-hover)] px-4 text-[var(--notion-text)]', wide ? 'py-[6vh]' : 'pt-[12vh]')}>
      <div className={cn('w-full', wide ? 'max-w-[680px]' : 'max-w-[400px]')}>
        <div className="mb-4 flex items-center justify-between">
          <Link to="/forms" className="text-[15px] font-semibold tracking-tight">
            {t(M['auth.brand'])}
          </Link>
          <EditionBadge />
        </div>
        <section className="rounded-lg border border-[var(--notion-border)] bg-white p-6 shadow-sm">
          <h1 className="text-[22px] font-semibold leading-tight">{title}</h1>
          {description ? <p className="mt-1.5 text-[14px] text-[var(--notion-text-muted)]">{description}</p> : null}
          <div className="mt-5">{children}</div>
        </section>
        {footer ? <div className="mt-4 text-center text-[13px] text-[var(--notion-text-muted)]">{footer}</div> : null}
      </div>
    </main>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[13px] font-medium text-zinc-800">{label}</span>
      {children}
    </label>
  );
}

export function FormError({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-[13px] text-red-600">
      {message}
    </p>
  ) : null;
}

export function Notice({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="status" className={cn('rounded-md bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800', className)}>
      {children}
    </p>
  );
}
