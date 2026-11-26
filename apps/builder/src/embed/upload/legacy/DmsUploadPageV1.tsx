import { useEffect, useMemo, useRef, useState } from 'react';
import type { RendererHandle } from '@form/renderer';
import { ChildTransport } from '@/embed/bridge/childTransport';
import { embedEnv, resolveParent, type EmbedCap } from '@/embed/bridge/origins';
import { bridgeRemoteSource } from '@/embed/lookup/bridgeRemoteSource';
import { PROTOCOL_VERSION } from '@/embed/bridge/protocol';
import { UploadControllerV1, type RenderView } from './controllerV1';
import { UploadForm } from '../UploadForm';

/*
 * RETIRED fp-bridge/1 page (same-origin iframe, `?fp_parent=`): only the M2 legacy build (VITE_FP_LEGACY_DESCRIPTOR=1) loads it, and
 * only for `fp_v=1`; deleted at M4 (SEC-DESIGN 3.5).
 *
 * `/embed/dms-upload`: the field form of DMS upload step 2, hosted in an iframe by the classic frontend (child side of
 * fp-bridge/1, DESIGN.md section 4). The page does nothing until the parent proves itself: `?fp_parent=` must name an
 * allowlisted origin (VITE_FP_EMBED_PARENTS; unset = this origin), this page must be framed, and from then on only
 * messages from that window and origin are read. It holds no token and calls no API; DMS keeps the master, the
 * doctype and the save.
 */

const PROBLEM_TEXT = {
  not_framed: 'This page is the field form of the DMS upload step. Open it from DMS.',
  missing: 'This page is the field form of the DMS upload step. Open it from DMS.',
  malformed: 'This page was opened with an address it cannot read. Go back to DMS and try again.',
  not_allowed: 'This page cannot be shown inside the site that opened it.',
  version: 'DMS and this form speak different versions of the upload protocol.',
} as const;
type Problem = keyof typeof PROBLEM_TEXT;

type Gate = { ok: true; parentOrigin: string; version: string | null; caps: readonly EmbedCap[] } | { ok: false; problem: Problem };

function openGate(win: Window): Gate {
  if (win.parent === win) return { ok: false, problem: 'not_framed' };
  const env = embedEnv(win.location.search, win.location.origin);
  const parent = resolveParent(win.location.search, env);
  if (!parent.ok) return { ok: false, problem: parent.reason };
  return { ok: true, parentOrigin: parent.parentOrigin, version: env.version, caps: env.caps };
}

const RESIZE_DEBOUNCE_MS = 50;

export default function DmsUploadPageV1() {
  const gate = useMemo(() => openGate(window), []);
  if (!gate.ok) return <Notice problem={gate.problem} />;
  return <Host parentOrigin={gate.parentOrigin} version={gate.version} caps={gate.caps} />;
}

function Notice({ problem }: { problem: Problem }) {
  return (
    <main className="mx-auto max-w-[560px] p-6 text-[14px] text-muted-foreground" data-testid="upload-notice" data-problem={problem}>
      <p>{PROBLEM_TEXT[problem]}</p>
    </main>
  );
}

function Host({ parentOrigin, version, caps }: { parentOrigin: string; version: string | null; caps: readonly EmbedCap[] }) {
  const [view, setView] = useState<RenderView | null>(null);
  const [today, setToday] = useState('01-01-2026');
  const handle = useRef<RendererHandle | null>(null);
  const controller = useRef<UploadControllerV1 | null>(null);
  const transport = useRef<ChildTransport | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const mismatch = version !== null && version !== PROTOCOL_VERSION;
  const lookupEnabled = caps.includes('lookup');
  /** The parent's lookup source: only when it announced the capability in the iframe URL. */
  const remote = useMemo(() => (lookupEnabled ? bridgeRemoteSource(() => controller.current) : undefined), [lookupEnabled]);

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
    const link = new ChildTransport({
      self: window,
      parent: window.parent,
      parentOrigin,
      onMessage: (message) => {
        if (message.type === 'init') setToday(message.payload.context.today);
        controller.current?.receive(message);
      },
      onDropped: (why) => console.warn('[formplus] dropped message', why),
    });
    const logic = new UploadControllerV1({
      send: (type, payload, replyTo) => link.send(type, payload, replyTo),
      onRender: setView,
      showInlineErrors: async () => void (await handle.current?.validate()),
      lookupEnabled,
    });
    transport.current = link;
    controller.current = logic;
    if (mismatch) {
      link.send('error', { code: 'unsupported_version', message: `This page speaks fp-bridge/${PROTOCOL_VERSION}, not fp-bridge/${version}`, fatal: true });
      return () => {
        transport.current = null;
        controller.current = null;
      };
    }
    link.start();
    link.send('ready', { version: PROTOCOL_VERSION, capabilities: ['options', 'readOnly'] });
    return () => {
      link.stop();
      logic.dispose();
      transport.current = null;
      controller.current = null;
    };
  }, [parentOrigin, mismatch, version, lookupEnabled]);

  // Height to the parent whenever the form's size changes (debounced), so its iframe never scrolls.
  useEffect(() => {
    const node = wrap.current;
    if (!node || mismatch || typeof ResizeObserver === 'undefined') return;
    let last = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const height = Math.ceil(node.getBoundingClientRect().height);
      if (height === last) return;
      last = height;
      transport.current?.send('resize', { height });
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
  }, [mismatch]);

  if (mismatch) return <Notice problem="version" />;
  return (
    <div ref={wrap} className="fp-upload" data-testid="upload-root" data-revision={view?.revision ?? 0}>
      {view ? (
        <UploadForm
          view={view}
          today={today}
          handleRef={handle}
          onAnswers={(answers) => controller.current?.setAnswers(answers)}
          onError={(error) => controller.current?.fail('render_failed', error.message)}
          {...(remote ? { remote } : {})}
        />
      ) : null}
    </div>
  );
}
