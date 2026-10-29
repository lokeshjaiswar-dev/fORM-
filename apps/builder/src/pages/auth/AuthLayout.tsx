import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { Alert, AlertDescription, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, TextLink } from '@dmacq/ui';
import { EditionBadge } from '@/edition/EditionBadge';
import { cn } from '@/lib/utils';

const M = defineMessages('builder', {
  'auth.brand': 'fORM-',
});

export { Field };

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
    <main className={cn('flex min-h-screen items-start justify-center bg-surface-moderate px-4 text-foreground', wide ? 'py-[6vh]' : 'pt-[12vh]')}>
      <div className={cn('w-full', wide ? 'max-w-[680px]' : 'max-w-[400px]')}>
        <div className="mb-4 flex items-center justify-between">
          <TextLink asChild size="medium" underline={false} className="font-semibold tracking-tight">
            <Link to="/forms">{t(M['auth.brand'])}</Link>
          </TextLink>
          <EditionBadge />
        </div>
        <Card>
          <CardHeader>
            <CardTitle as="h1">{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
        {footer ? <div className="mt-4 text-center text-[13px] text-muted-foreground">{footer}</div> : null}
      </div>
    </main>
  );
}

export function FormError({ message }: { message: string | null }) {
  return message ? (
    <Alert variant="destructive" icon>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  ) : null;
}

export function Notice({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Alert variant="success" icon className={className}>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
