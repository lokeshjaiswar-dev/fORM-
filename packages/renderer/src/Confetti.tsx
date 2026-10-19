import { useEffect, useRef } from 'react';

const COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

type Piece = {
  x: number;
  y: number;
  w: number;
  h: number;
  vx: number;
  vy: number;
  rot: number;
  vr: number;
  color: string;
  shape: 0 | 1 | 2;
};

/** DSN-11 success burst; nothing moves when the respondent prefers reduced motion, and it stops after a few seconds. */
export function Confetti() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = 0;
    let h = 0;
    const pieces: Piece[] = [];
    let frame = 0;
    let raf = 0;

    function resize() {
      const parent = canvas!.parentElement;
      w = parent?.clientWidth || 1;
      h = parent?.clientHeight || 1;
      canvas!.width = w * devicePixelRatio;
      canvas!.height = h * devicePixelRatio;
      canvas!.style.width = `${w}px`;
      canvas!.style.height = `${h}px`;
      ctx!.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    }

    function add(x: number, y: number, vx: number, vy: number) {
      pieces.push({
        x,
        y,
        w: 6 + Math.random() * 7,
        h: 4 + Math.random() * 5,
        vx,
        vy,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.12,
        color: COLORS[Math.floor(Math.random() * COLORS.length)] ?? '#3b82f6',
        shape: (Math.floor(Math.random() * 3) as 0 | 1 | 2),
      });
    }

    function burst() {
      for (let i = 0; i < 55; i++) add(0, h * 0.45, 1.2 + Math.random() * 3.2, -4 - Math.random() * 5);
      for (let i = 0; i < 55; i++) add(w, h * 0.45, -(1.2 + Math.random() * 3.2), -4 - Math.random() * 5);
      for (let i = 0; i < 80; i++) add(Math.random() * w, -12, (Math.random() - 0.5) * 1.4, 0.6 + Math.random() * 1.8);
    }

    resize();
    burst();

    function tick() {
      frame += 1;
      if (frame > 360) {
        ctx!.clearRect(0, 0, w, h);
        return;
      }
      ctx!.clearRect(0, 0, w, h);
      if (frame === 50 || frame === 110) burst();
      for (const p of pieces) {
        p.vy += 0.06;
        p.vx *= 0.996;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx!.save();
        ctx!.translate(p.x, p.y);
        ctx!.rotate(p.rot);
        ctx!.globalAlpha = 0.92;
        ctx!.fillStyle = p.color;
        if (p.shape === 0) ctx!.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        else if (p.shape === 1) {
          ctx!.beginPath();
          ctx!.arc(0, 0, p.w / 2, 0, Math.PI * 2);
          ctx!.fill();
        } else {
          ctx!.beginPath();
          ctx!.moveTo(0, -p.h);
          ctx!.lineTo(p.w / 2, p.h / 2);
          ctx!.lineTo(-p.w / 2, p.h / 2);
          ctx!.closePath();
          ctx!.fill();
        }
        ctx!.restore();
      }
      raf = requestAnimationFrame(tick);
    }

    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
    if (canvas.parentElement) ro?.observe(canvas.parentElement);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="fr-confetti" aria-hidden="true" />;
}
