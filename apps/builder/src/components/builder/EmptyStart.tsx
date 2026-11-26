import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/state/uiStore';
import '@/components/builder/emptyStart.css';

const M = defineMessages('builder', {
  'start.drag': 'Drag & drop your first element from the left panel.',
  'start.slash': 'Type {slash} to insert a field.',
});

/**
 * The blank form (Figma DMacq Design System 5356:183717): a dashed drop area with a looping drag-and-drop
 * illustration and the two ways to begin. Dropping a field anywhere on the canvas adds it; pressing the area (or Enter
 * in the title) opens the insert line, where typing "/" lists the fields.
 */
export function EmptyStart() {
  const startBlank = useUiStore((s) => s.startBlank);
  const [slashBefore, slashAfter] = t(M['start.slash'], { slash: '\u0000' }).split('\u0000');

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        startBlank();
      }}
      className="mt-2 flex w-full cursor-pointer flex-col items-center gap-2 overflow-hidden rounded-[8px] border border-dashed border-(--bluedark-a200) bg-(--bluedark-050) px-6 pb-10 pt-4 text-center outline-none transition-colors hover:border-(--bluedark-500) focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    >
      <DragDropLoop />
      <span className="flex flex-wrap items-start justify-center gap-x-2 gap-y-1 text-[14px] font-medium leading-5 text-(--bluedark-900)">
        {/* The spaces between flex items are invisible, but keep the button's accessible name readable. */}
        <span>{t(M['start.drag'])}</span>{' '}
        <span className="flex items-start gap-1">
          {slashBefore?.trimEnd()}{' '}
          <kbd className="flex h-5 items-center rounded-[4px] bg-[rgba(35,131,226,0.16)] px-1.5 font-sans text-[15px] font-medium text-[#2383e2]">/</kbd>{' '}
          {slashAfter?.trimStart()}
        </span>
      </span>
    </button>
  );
}

/* Figma frame "Drag & Drop · Minimal loop (8s)", 462 × 264, positions in its own pixels. */
const HAIRLINE = 0.846;
const BAR = 'rgba(108,132,157,0.22)';
const BLOCK_TOPS = [30.46, 67.69, 104.92, 142.15, 179.38] as const;
const BLOCK_BARS = [47.385, 37.231, 54.154, 33.846, 44] as const;
const SLOTS = [
  { top: 30.46, height: 44 },
  { top: 81.23, height: 44 },
  { top: 132, height: 69.385 },
] as const;

const at = (left: number, top: number, width: number, height: number, extra: CSSProperties = {}): CSSProperties => ({ position: 'absolute', left, top, width, height, ...extra });

const LOOP_WIDTH = 462;
const LOOP_HEIGHT = 264;

/** Scale (at most 1) that fits the illustration in the width its box gets, so a narrow canvas shrinks it instead of cutting it off. */
function useFitScale(): [RefObject<HTMLSpanElement | null>, number] {
  const ref = useRef<HTMLSpanElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const fit = () => setScale(Math.min(1, el.clientWidth / LOOP_WIDTH) || 1);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, scale];
}

function DragDropLoop() {
  const [boxRef, scale] = useFitScale();
  return (
    <span ref={boxRef} aria-hidden className="block w-full max-w-[462px] shrink-0" style={{ height: LOOP_HEIGHT * scale }}>
      <span className="relative block origin-top-left overflow-hidden bg-(--bluedark-050)" style={{ width: LOOP_WIDTH, height: LOOP_HEIGHT, transform: scale < 1 ? `scale(${scale})` : undefined }}>
        <span style={at(14.38, 16.92, 135.38, 230.15, { background: '#fff', border: `${HAIRLINE}px solid rgba(108,132,157,0.12)`, borderRadius: 8.46 })} />
        <span className="es-anim es-canvas" style={at(170.08, 16.92, 277.54, 230.15, { background: '#fff', border: `${HAIRLINE}px solid #eaeef1`, borderRadius: 8.46 })} />
        {BLOCK_TOPS.map((top, i) => (
          <PaletteBlock key={top} top={top} bar={BLOCK_BARS[i]!} className={i < 3 ? `es-anim es-block-${i + 1}` : undefined} />
        ))}
        {SLOTS.map((s, i) => (
          <span key={s.top} className={`es-anim es-slot-${i + 1}`} style={at(183.62, s.top, 250.46, s.height, { background: '#f0f4fa', border: `${HAIRLINE}px dashed #80a3d5`, borderRadius: 6.77 })} />
        ))}
        <FormRow n={1} top={33.85} label={60.923} fieldHeight={25.385} />
        <FormRow n={2} top={84.62} label={47.385} fieldHeight={25.385} split />
        <FormRow n={3} top={135.38} label={74.462} fieldHeight={50.769} />
        <span className="es-anim es-submit" style={at(363, 216.62, 67.69, 20.31, { background: '#3b82f6', borderRadius: 5.08 })} />
        {BLOCK_TOPS.slice(0, 3).map((top, i) => (
          <PaletteBlock key={top} top={top} bar={BLOCK_BARS[i]!} ghost className={`es-anim es-ghost-${i + 1}`} />
        ))}
        <span className="es-anim es-cursor" style={at(214.08, 216.62, 16.92, 16.92)}>
          <svg viewBox="0 0 16.9231 16.9231" className="block size-full" fill="none">
            <path d="M3.52573 1.7628V13.75L6.55778 10.859L8.60265 15.2307L10.436 14.3846L8.39111 10.0833H12.5514L3.52573 1.7628Z" fill="#1B2533" stroke="#fff" strokeWidth={1.05769} strokeLinejoin="round" />
          </svg>
        </span>
      </span>
    </span>
  );
}

/** A field in the illustrated left panel; a ghost is the copy that travels to the canvas. */
function PaletteBlock({ top, bar, ghost = false, className }: { top: number; bar: number; ghost?: boolean; className?: string | undefined }) {
  return (
    <span
      className={className}
      style={at(27.92, top, 108.31, 27.08, {
        background: '#fff',
        border: `${HAIRLINE}px solid ${ghost ? '#6691cd' : '#dfe4e9'}`,
        borderRadius: 5.08,
        ...(ghost ? { filter: 'drop-shadow(0 5.077px 6.769px rgba(25,40,57,0.16))' } : {}),
      })}
    >
      <span style={at(7.62, 10.15, bar, 5.08, { background: BAR, borderRadius: 2.54 })} />
      <span style={at(87.15, 5.92, 13.54, 13.54, { background: '#b2c8e6', borderRadius: 3.385 })} />
    </span>
  );
}

/** A row that lands on the illustrated canvas: a label line over one field, two fields, or a tall field. */
function FormRow({ n, top, label, fieldHeight, split = false }: { n: number; top: number; label: number; fieldHeight: number; split?: boolean }) {
  const field = (left: number, width: number): ReactNode => (
    <span key={left} style={at(left, 11.85, width, fieldHeight, { background: '#fff', border: `${HAIRLINE}px solid rgba(108,132,157,0.28)`, borderRadius: 5.08 })} />
  );
  return (
    <span className={cn('es-anim', `es-row-${n}`)} style={at(187, top, 243.69, 11.85 + fieldHeight)}>
      <span style={at(0, 0, label, 5.08, { background: BAR, borderRadius: 2.54 })} />
      {split ? [field(0, 116.77), field(126.92, 116.77)] : field(0, 243.69)}
    </span>
  );
}
