import { useEffect, useRef } from 'react';

type Point = { x: number; y: number };

export interface SignaturePadProps {
  disabled?: boolean | undefined;
  /**
   * Called as each stroke ends with the drawing's PNG, which the canvas encodes asynchronously (B4: never without a
   * stroke), and with null after Clear. Calling it at once lets a form wait for the encoding before it submits.
   */
  onChange?: ((png: Promise<Blob | null> | null) => void) | undefined;
  /** Stroke colour; any CSS colour, `var(--fr-text)` by default. */
  penColor?: string | undefined;
  heightPx?: number | undefined;
  label?: string | undefined;
  clearLabel?: string | undefined;
  id?: string | undefined;
  describedBy?: string | undefined;
}

/** The colour a CSS value computes to, so the canvas can draw with theme variables. */
function resolveColor(canvas: HTMLCanvasElement, color: string): string {
  if (!color.startsWith('var(')) return color;
  const probe = canvas.ownerDocument.createElement('span');
  probe.style.color = color;
  probe.style.display = 'none';
  canvas.parentElement?.appendChild(probe);
  const resolved = canvas.ownerDocument.defaultView?.getComputedStyle(probe).color || '#111111';
  probe.remove();
  return resolved;
}

/**
 * FLD-28 drawing surface. The backing store is scaled by devicePixelRatio and redrawn on resize (B5); listeners bind
 * once and read the latest props from refs (B6).
 */
export function SignaturePad({ disabled, onChange, penColor = 'var(--fr-text)', heightPx = 160, label = 'Signature', clearLabel = 'Clear', id, describedBy }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const disabledRef = useRef(disabled);
  const onChangeRef = useRef(onChange);
  const colorRef = useRef(penColor);

  useEffect(() => {
    disabledRef.current = disabled;
    onChangeRef.current = onChange;
    colorRef.current = penColor;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let stroke: Point[] | null = null;

    function line([first, ...rest]: Point[]) {
      if (!first) return;
      ctx!.beginPath();
      ctx!.moveTo(first.x, first.y);
      for (const p of rest) ctx!.lineTo(p.x, p.y);
      ctx!.stroke();
    }

    function resize() {
      const r = canvas!.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = Math.round(r.width * dpr);
      canvas!.height = Math.round(r.height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.strokeStyle = resolveColor(canvas!, colorRef.current);
      ctx!.lineWidth = 2;
      ctx!.lineCap = 'round';
      ctx!.lineJoin = 'round';
      for (const s of strokes.current) if (s.length > 1) line(s);
    }

    function pos(e: PointerEvent) {
      const r = canvas!.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function down(e: PointerEvent) {
      if (disabledRef.current) return;
      stroke = [pos(e)];
    }
    function move(e: PointerEvent) {
      if (!stroke) return;
      stroke.push(pos(e));
      line(stroke.slice(-2));
    }
    function up() {
      if (!stroke) return;
      if (stroke.length > 1) {
        strokes.current.push(stroke);
        onChangeRef.current?.(new Promise((resolve) => canvas!.toBlob(resolve, 'image/png')));
      }
      stroke = null;
    }

    resize();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    observer?.observe(canvas);
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      observer?.disconnect();
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, []);

  function clear() {
    const canvas = canvasRef.current;
    strokes.current = [];
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    onChange?.(null);
  }

  return (
    <div className="fr-signature">
      <canvas
        ref={canvasRef}
        id={id}
        width={480}
        height={heightPx}
        role="img"
        aria-label={label}
        aria-describedby={describedBy}
        className="fr-signature-canvas"
        style={{ height: `${heightPx}px` }}
      />
      {disabled ? null : (
        <button type="button" onClick={clear} className="fr-link-button fr-signature-clear">
          {clearLabel}
        </button>
      )}
    </div>
  );
}
