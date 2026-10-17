import { useEffect } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import { BuilderHeader } from '@/components/builder/BuilderHeader';
import { FieldPicker } from '@/components/builder/FieldPicker';
import { FormCanvas } from '@/components/builder/FormCanvas';
import { BlockInspector } from '@/components/builder/BlockInspector';
import { FormPreview } from '@/components/preview/FormPreview';
import { BuilderDnd } from '@/components/builder/BuilderDnd';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { useFormStore } from '@/store/useFormStore';

export function BuilderPage() {
  const { id } = useParams();
  const location = useLocation();
  const mode = useFormStore((s) => s.mode);
  const form = useFormStore((s) => s.form);
  const setMode = useFormStore((s) => s.setMode);

  useEffect(() => {
    if (location.pathname.endsWith('/preview')) setMode('preview');
  }, [location.pathname, setMode]);

  return (
    <BuilderDnd>
      <div className="flex h-svh bg-white text-[var(--notion-text)]">
        <FieldPicker />
        <div className="flex min-w-0 flex-1 flex-col">
          <BuilderHeader />
          <div className="flex min-h-0 flex-1">
            {mode === 'edit' ? (
              <ErrorBoundary key="edit" label="canvas">
                <FormCanvas />
              </ErrorBoundary>
            ) : (
              <ErrorBoundary key="preview" label="preview">
                <FormPreview key={form.blocks.map((b) => b.id).join('|')} />
              </ErrorBoundary>
            )}
            {mode === 'edit' && <BlockInspector />}
          </div>
        </div>
        <span className="sr-only">Form {id}</span>
      </div>
    </BuilderDnd>
  );
}
