import { Link, useParams } from 'react-router-dom';
import { BuilderHeader } from '@/components/builder/BuilderHeader';
import { FieldPicker } from '@/components/builder/FieldPicker';
import { FormCanvas } from '@/components/builder/FormCanvas';
import { BlockInspector } from '@/components/builder/BlockInspector';
import { DeleteBlockDialog } from '@/components/builder/DeleteBlockDialog';
import { SessionBanners } from '@/components/builder/SessionBanners';
import { FormPreview } from '@/components/preview/FormPreview';
import { BuilderDnd } from '@/components/builder/BuilderDnd';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useFormSession } from '@/persistence/useFormSession';
import { useBuilderMode } from '@/pages/useBuilderMode';
import { useHistoryShortcuts } from '@/state/history';
import { useDoc } from '@/state/documentStore';

/** `/builder/:id` and `/builder/:id/preview`: the form the URL names, loaded from the repository. */
export function BuilderPage() {
  const { id = '' } = useParams();
  const session = useFormSession(id);

  if (session.status === 'ready') return <Builder />;
  if (session.status === 'loading') return <main className="h-svh bg-white" aria-busy="true" />;
  return (
    <main className="mx-auto max-w-[720px] px-8 pt-[72px] text-[var(--notion-text)]">
      <h1 className="text-[28px] font-bold">{session.status === 'missing' ? 'Form not found' : 'This form cannot be opened'}</h1>
      <p className="mt-2 text-[15px] text-[var(--notion-text-muted)]">
        {session.status === 'missing' ? 'No form with this address is saved in this browser.' : session.message}
      </p>
      <Link to="/forms" className="mt-6 inline-block text-[15px] font-medium text-[#2383e2] hover:underline">
        Back to forms
      </Link>
    </main>
  );
}

function Builder() {
  const [mode] = useBuilderMode();
  const blockKey = useDoc((d) => d.blocks.map((b) => b.id).join('|'));
  useHistoryShortcuts();

  return (
    <BuilderDnd>
      <div className="flex h-svh bg-white text-[var(--notion-text)]">
        <FieldPicker />
        <div className="flex min-w-0 flex-1 flex-col">
          <BuilderHeader />
          <SessionBanners />
          <div className="flex min-h-0 flex-1">
            {mode === 'edit' ? (
              <ErrorBoundary key="edit" label="canvas">
                <FormCanvas />
              </ErrorBoundary>
            ) : (
              <ErrorBoundary key="preview" label="preview">
                <FormPreview key={blockKey} />
              </ErrorBoundary>
            )}
            {mode === 'edit' && <BlockInspector />}
          </div>
        </div>
        <DeleteBlockDialog />
      </div>
    </BuilderDnd>
  );
}
