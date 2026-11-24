import { Component, type ReactNode, type Ref } from 'react';
import { FormRenderer, type RendererHandle } from '@form/renderer';
import type { Answers, FileRef, Locale } from '@form/schema';
import type { RenderView } from './controller.ts';
import { sessionStart } from './plan.ts';

/** The doctype and master fields as one renderer form with no navigation. Remounted (by `view.revision`) whenever the controller replans. */

const refuseUpload = (): Promise<FileRef> => Promise.reject(new Error('Files are not part of the upload step form'));

class Boundary extends Component<{ children: ReactNode; onError: (error: Error) => void }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  override render() {
    return this.state.failed ? <p role="alert">These fields could not be shown. DMS will show its own form.</p> : this.props.children;
  }
}

export function UploadForm({ view, today, handleRef, onAnswers, onError }: {
  view: RenderView;
  /** DD-MM-YYYY, from the parent; pins the renderer's clock. */
  today: string;
  handleRef: Ref<RendererHandle>;
  onAnswers: (answers: Answers) => void;
  onError: (error: Error) => void;
}) {
  return (
    <Boundary key={view.revision} onError={onError}>
      <FormRenderer
        version={view.plan.version}
        mode="live"
        status={{ state: 'open' }}
        locale={view.locale as Locale}
        initialAnswers={view.plan.initialAnswers}
        session={{ startedAt: sessionStart(today) }}
        onSubmit={() => undefined}
        uploader={refuseUpload}
        hideNavigation
        onAnswersChange={onAnswers}
        handleRef={handleRef}
      />
    </Boundary>
  );
}
