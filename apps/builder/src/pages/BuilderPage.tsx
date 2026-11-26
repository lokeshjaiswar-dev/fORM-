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
import { useUiStore } from '@/state/uiStore';
import { TextLink } from '@dmacq/ui';
import { useViewTransitionArrival } from '@/lib/viewTransition';

/** `/builder/:id` and `/builder/:id/preview`: the form the URL names, loaded from the repository. */
export function BuilderPage() {
  const { id = '' } = useParams();
  const session = useFormSession(id);

  if (session.status === 'ready') return <Builder />;
  if (session.status === 'loading') return <BuilderSkeleton />;
  return <OpenFailed missing={session.status === 'missing'} message={session.status === 'error' ? session.message : ''} />;
}

/** The form could not be opened. It also ends a crossfade from the forms list, so the page never waits on it. */
function OpenFailed({ missing, message }: { missing: boolean; message: string }) {
  useViewTransitionArrival();
  return (
    <main className="mx-auto max-w-[720px] px-8 pt-[72px] text-foreground">
      <h1 className="text-[28px] font-bold">{missing ? 'Form not found' : 'This form cannot be opened'}</h1>
      <p className="mt-2 text-[15px] text-muted-foreground">
        {missing ? 'No form with this address is saved in this browser.' : message}
      </p>
      <TextLink asChild className="mt-6">
        <Link to="/forms">Back to forms</Link>
      </TextLink>
    </main>
  );
}

/**
 * The builder's frame (top bar, toolbox column, canvas backdrop) while the form loads, so arriving from the forms list
 * crossfades into the builder's shape instead of a blank page. The panels' contents then land (see `builder-land`).
 */
function BuilderSkeleton() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  useViewTransitionArrival();
  return (
    <main className="flex h-svh flex-col bg-background" aria-busy="true" aria-label="Opening form">
      <div className="h-14 shrink-0 border-b border-sidebar-border bg-sidebar" />
      <div className="flex min-h-0 flex-1">
        {sidebarOpen ? <div className="w-[240px] shrink-0 border-r border-border bg-card" /> : null}
        <div className="min-w-0 flex-1 bg-(--bluedark-200)" />
      </div>
    </main>
  );
}

function Builder() {
  const [mode] = useBuilderMode();
  useViewTransitionArrival();
  const designOpen = useUiStore((s) => s.designOpen);
  const structure = useDoc((d) => d.pages.map((p) => p.children.join(',')).join('|'));
  useHistoryShortcuts();
  useBlockClipboard();
  useEffect(preloadGallery, []);

  return (
    <BuilderDnd>
      {/* The top bar spans the whole window; the field sidebar, canvas and inspector sit below it. */}
      {/* builder-land: the header's contents, the toolbox and the canvas ease in once, when the form opens. */}
      <div className="builder-land flex h-svh flex-col bg-background text-foreground">
        <BuilderHeader />
        <SessionBanners />
        {/* The canvas backdrop's default colour, behind the canvas while it fades in (it matches BuilderSkeleton). */}
        <div className="builder-land-body flex min-h-0 flex-1 bg-(--bluedark-200)">
          <FieldPicker />
          <div className="builder-land-canvas flex min-h-0 min-w-0 flex-1">
            <FormDesignPanel showTrigger={false}>
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
            {mode === 'edit' && !designOpen && <BlockInspector />}
          </div>
        </div>
        <DeleteBlockDialog />
      </div>
    </BuilderDnd>
  );
}
