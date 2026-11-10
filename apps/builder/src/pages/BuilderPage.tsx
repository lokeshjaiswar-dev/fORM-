import { useEffect } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BuilderHeader } from '@/components/builder/BuilderHeader';
import { FieldPicker } from '@/components/builder/FieldPicker';
import { FormCanvas } from '@/components/builder/FormCanvas';
import { FormDesignPanel } from '@/components/builder/FormDesignPanel';
import { BlockInspector } from '@/components/builder/BlockInspector';
import { DeleteBlockDialog } from '@/components/builder/DeleteBlockDialog';
import { SessionBanners } from '@/components/builder/SessionBanners';
import { FormPreview } from '@/components/preview/PreviewPane';
import { BuilderDnd } from '@/components/builder/BuilderDnd';
import { useBlockClipboard } from '@/components/builder/useBlockClipboard';
import { preloadGallery } from '@/components/templates/gallery';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useFormSession } from '@/persistence/useFormSession';
import { useBuilderMode } from '@/pages/useBuilderMode';
import { useHistoryShortcuts } from '@/state/history';
import { useDoc } from '@/state/documentStore';
import { TextLink } from '@dmacq/ui';

/** `/builder/:id` and `/builder/:id/preview`: the form the URL names, loaded from the repository. */
export function BuilderPage() {
  const { id = '' } = useParams();
  const session = useFormSession(id);

  if (session.status === 'ready') return <Builder />;
  if (session.status === 'loading') return <main className="h-svh bg-background" aria-busy="true" />;
  return (
    <main className="mx-auto max-w-[720px] px-8 pt-[72px] text-foreground">
      <h1 className="text-[28px] font-bold">{session.status === 'missing' ? 'Form not found' : 'This form cannot be opened'}</h1>
      <p className="mt-2 text-[15px] text-muted-foreground">
        {session.status === 'missing' ? 'No form with this address is saved in this browser.' : session.message}
      </p>
      <TextLink asChild className="mt-6">
        <Link to="/forms">Back to forms</Link>
      </TextLink>
    </main>
  );
}

function Builder() {
  const [mode] = useBuilderMode();
  const structure = useDoc((d) => d.pages.map((p) => p.children.join(',')).join('|'));
  useHistoryShortcuts();
  useBlockClipboard();
  useEffect(preloadGallery, []);

  return (
    <BuilderDnd>
      <div className="flex h-svh bg-background text-foreground">
        <FieldPicker />
        <div className="flex min-w-0 flex-1 flex-col">
          <BuilderHeader />
          <SessionBanners />
          <div className="flex min-h-0 flex-1">
            <FormDesignPanel>
              {mode === 'edit' ? (
                <ErrorBoundary key="edit" label="canvas">
                  <FormCanvas />
                </ErrorBoundary>
              ) : (
                <ErrorBoundary key="preview" label="preview">
                  <FormPreview key={structure} />
                </ErrorBoundary>
              )}
            </FormDesignPanel>
            {mode === 'edit' && <BlockInspector />}
          </div>
        </div>
        <DeleteBlockDialog />
      </div>
    </BuilderDnd>
  );
}
