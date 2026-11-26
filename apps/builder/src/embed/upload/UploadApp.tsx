import { useEffect, useMemo, useRef, useState } from 'react';
import type { RendererHandle } from '@form/renderer';
import { ChildPort } from '@/embed/bridge/childPort';
import { embedParents } from '@/embed/bridge/parents';
import { bridgeRemoteSource } from '@/embed/lookup/bridgeRemoteSource';
import { UploadController, type RenderView } from './controller';
import { UploadForm } from './UploadForm';

/*
 * `/formplus/embed/dms-upload` (fp-bridge/2, SEC-DESIGN 3): the field form of DMS upload step 2, hosted by the classic live `upload`
 * module in `<iframe sandbox="allow-scripts allow-forms">`. It runs in an opaque origin, so it has no cookie, no storage and no
 * network (the response says `connect-src 'none'`), holds no credential and calls no API: DMS keeps the master, the doctype and the
 * save. The page does nothing until the parent hands over a MessagePort (`bridge/childPort.ts`: only window.parent, only an
 * allowlisted origin, only once); from then on every message is on that port. It answers `state` while the person types and the
 * values only in `collected`, once per `collect`.
 */

const PROBLEM_TEXT = {
  not_framed: 'This page is the field form of the DMS upload step. Open it from DMS.',
  not_allowed: 'This page cannot be shown inside the site that opened it.',
} as const;
type Problem = keyof typeof PROBLEM_TEXT;

type Gate = { ok: true; parents: readonly string[] } | { ok: false; problem: Problem };

function openGate(win: Window): Gate {
  if (win.parent === win) return { ok: false, problem: 'not_framed' };
  const parents = embedParents();
  if (parents.length === 0) return { ok: false, problem: 'not_allowed' };
  return { ok: true, parents };
}

const RESIZE_DEBOUNCE_MS = 50;

export default function UploadApp() {
  const gate = useMemo(() => openGate(window), []);
  if (!gate.ok) return <Notice problem={gate.problem} />;
  return <Host parents={gate.parents} />;
}

function Notice({ problem }: { problem: Problem }) {
  return (
    <main className="mx-auto max-w-[560px] p-6 text-[14px] text-muted-foreground" data-testid="upload-notice" data-problem={problem}>
      <p>{PROBLEM_TEXT[problem]}</p>
    </main>
  );
}

function Host({ parents }: { parents: readonly string[] }) {
  const [view, setView] = useState<RenderView | null>(null);
  const [today, setToday] = useState('01-01-2026');
  const [connected, setConnected] = useState(false);
  const handle = useRef<RendererHandle | null>(null);
  const controller = useRef<UploadController | null>(null);
  const port = useRef<ChildPort | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  /** The parent's lookup source: declared lookups only (the controller refuses any other id). */
  const remote = useMemo(() => bridgeRemoteSource(() => controller.current), []);

  useEffect(() => {
    // The parent supplies the page background; the iframe must not paint over it.
    const root = document.documentElement;
    const before = [root.style.background, document.body.style.background];
    root.style.background = 'transparent';
    document.body.style.background = 'transparent';
    return () => {
      root.style.background = before[0] ?? '';
      document.body.style.background = before[1] ?? '';
    };
  }, []);

  useEffect(() => {
    let logic: UploadController | null = null;
    const link = new ChildPort({
      self: window,
      parent: window.parent,
      allowedParents: parents,
      onPort: (dialogId) => {
        logic = new UploadController({
          dialogId,
          send: (body) => void link.send(body),
          onRender: setView,
          showInlineErrors: async () => void (await handle.current?.validate()),
          onProblem: (code, why) => console.warn('[formplus] ', code, why),
        });
        controller.current = logic;
        setConnected(true);
      },
      onMessage: (message) => {
        if (message.type === 'init') setToday(message.context.today);
        logic?.receive(message);
      },
      onDropped: (why) => console.warn('[formplus] dropped message', why),
    });
    port.current = link;
    link.start();
    return () => {
      link.stop();
      logic?.dispose();
      port.current = null;
      controller.current = null;
      setConnected(false);
    };
  }, [parents]);

  // Height to the parent whenever the form's size changes (debounced), so its iframe never scrolls.
  useEffect(() => {
    const node = wrap.current;
    if (!connected || !node || typeof ResizeObserver === 'undefined') return;
    let last = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const height = Math.min(100_000, Math.ceil(node.getBoundingClientRect().height));
      if (height === last) return;
      last = height;
      port.current?.send({ type: 'resize', height });
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(report, RESIZE_DEBOUNCE_MS);
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [connected]);

  return (
    <div ref={wrap} className="fp-upload" data-testid="upload-root" data-revision={view?.revision ?? 0}>
      {view ? (
        <UploadForm
          view={view}
          today={today}
          handleRef={handle}
          onAnswers={(answers) => controller.current?.setAnswers(answers)}
          onError={(error) => controller.current?.fail('render_failed', error.message)}
          remote={remote}
        />
      ) : null}
    </div>
  );
}
