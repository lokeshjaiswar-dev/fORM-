import { useEffect, useRef } from 'react';

type Point = { x: number; y: number };

export function SignaturePad({
  disabled,
  onChange,
}: {
  disabled?: boolean;
  onChange?: (dataUrl: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const disabledRef = useRef(disabled);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    disabledRef.current = disabled;
    onChangeRef.current = onChange;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let stroke: Point[] | null = null;

    function line(points: Point[]) {
      ctx!.beginPath();
      ctx!.moveTo(points[0].x, points[0].y);
      for (const p of points.slice(1)) ctx!.lineTo(p.x, p.y);
      ctx!.stroke();
    }

    function resize() {
      const r = canvas!.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = Math.round(r.width * dpr);
      canvas!.height = Math.round(r.height * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.strokeStyle = '#111';
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
        onChangeRef.current?.(canvas!.toDataURL());
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
    onChange?.('');
  }

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        width={480}
        height={140}
        aria-label="Signature"
        className="block h-[140px] w-full touch-none rounded-md border border-zinc-200 bg-white"
      />
      {disabled ? null : (
        <button
          type="button"
          onClick={clear}
          className="absolute right-2 top-2 rounded-[4px] px-2 py-0.5 text-[12px] text-zinc-500 hover:bg-zinc-100"
        >
          Clear
        </button>
      )}
    </div>
  );
}
