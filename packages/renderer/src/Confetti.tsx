import { useEffect, useRef } from 'react';
import type { ConfettiStyle } from '@form/schema';

const PALETTES: Record<ConfettiStyle, string[]> = {
  classic: ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'],
  pastel: ['#f9a8d4', '#fde68a', '#a7f3d0', '#bfdbfe', '#c4b5fd', '#fdba74', '#fbcfe8'],
  ocean: ['#38bdf8', '#22d3ee', '#60a5fa', '#2dd4bf', '#7dd3fc', '#0ea5e9', '#a5f3fc'],
  sunset: ['#f97316', '#ef4444', '#fbbf24', '#ec4899', '#a855f7', '#fb7185', '#fde047'],
};

/** Each style is its own effect: a different particle and motion, not only a different palette. */
type Kind = 'piece' | 'heart' | 'bubble' | 'rocket' | 'spark' | 'trail';

type Particle = {
  kind: Kind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  rot: number;
  vr: number;
  color: string;
  shape: number;
  life: number;
  target: number;
  phase: number;
};

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(list: T[]): T => list[Math.floor(Math.random() * list.length)] ?? list[0]!;

function drawHeart(ctx: CanvasRenderingContext2D, s: number) {
  ctx.beginPath();
  ctx.moveTo(0, s * 0.35);
  ctx.bezierCurveTo(-s, -s * 0.35, -s * 0.5, -s * 1.05, 0, -s * 0.45);
  ctx.bezierCurveTo(s * 0.5, -s * 1.05, s, -s * 0.35, 0, s * 0.35);
  ctx.fill();
}

function drawBubble(ctx: CanvasRenderingContext2D, s: number, color: string) {
  const alpha = ctx.globalAlpha;
  ctx.globalAlpha = alpha * 0.55;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, s, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(-s * 0.35, -s * 0.35, s * 0.18, 0, Math.PI * 2);
  ctx.fill();
}

function drawRocket(ctx: CanvasRenderingContext2D, s: number, color: string, flicker: number) {
  /* Flame below the body, then the body pointing up. */
  ctx.fillStyle = '#fb923c';
  ctx.beginPath();
  ctx.moveTo(-s * 0.35, s * 0.6);
  ctx.lineTo(0, s * (1.6 + flicker));
  ctx.lineTo(s * 0.35, s * 0.6);
  ctx.closePath();
  ctx.fill();
  /* Fins on both sides. */
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-s * 0.5, s * 0.1);
  ctx.lineTo(-s * 0.95, s * 0.85);
  ctx.lineTo(-s * 0.5, s * 0.6);
  ctx.moveTo(s * 0.5, s * 0.1);
  ctx.lineTo(s * 0.95, s * 0.85);
  ctx.lineTo(s * 0.5, s * 0.6);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(0, -s * 1.4);
  ctx.quadraticCurveTo(s * 0.7, -s * 0.2, s * 0.5, s * 0.6);
  ctx.lineTo(-s * 0.5, s * 0.6);
  ctx.quadraticCurveTo(-s * 0.7, -s * 0.2, 0, -s * 1.4);
  ctx.fill();
  ctx.fillStyle = '#e2e8f0';
  ctx.beginPath();
  ctx.arc(0, -s * 0.1, s * 0.22, 0, Math.PI * 2);
  ctx.fill();
}

/** DSN-11 success effect; nothing moves when the respondent prefers reduced motion. */
export function Confetti({ style = 'classic' }: { style?: ConfettiStyle | undefined }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const colors = PALETTES[style];

    let w = 0;
    let h = 0;
    let particles: Particle[] = [];
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

    function make(kind: Kind, x: number, y: number, vx: number, vy: number, size: number, color = pick(colors)): Particle {
      return { kind, x, y, vx, vy, size, rot: Math.random() * Math.PI, vr: rand(-0.06, 0.06), color, shape: Math.floor(Math.random() * 3), life: 1, target: 0, phase: Math.random() * Math.PI * 2 };
    }

    /* Classic: confetti pieces bursting from both bottom corners and falling from the top. */
    function confettiBurst() {
      for (let i = 0; i < 55; i++) particles.push(make('piece', 0, h * 0.45, rand(1.2, 4.4), rand(-9, -4), rand(6, 13)));
      for (let i = 0; i < 55; i++) particles.push(make('piece', w, h * 0.45, -rand(1.2, 4.4), rand(-9, -4), rand(6, 13)));
    }

    /* Sunset: a rocket leaves a trail, then bursts into sparks at its target height. */
    function explode(p: Particle) {
      for (let i = 0; i < 120; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = rand(1, 3.5);
        particles.push({ ...make('spark', p.x, p.y, Math.cos(angle) * speed, Math.sin(angle) * speed, rand(3, 6), pick(colors)), life: 60 });
      }
    }

    resize();
    if (style === 'classic') {
      confettiBurst();
    }

    function tick() {
      frame += 1;
      if (frame > 900) {
        ctx!.clearRect(0, 0, w, h);
        return;
      }
      ctx!.clearRect(0, 0, w, h);

      /* Spawning per style. */
      if (style === 'classic' && (frame === 50 || frame === 110)) confettiBurst();
      if (style === 'pastel' && frame < 200) {
        for (let i = 0; i < 2; i++) particles.push(make('heart', rand(0, w), -20, 0, rand(1, 2.6), rand(8, 14)));
      }
      if (style === 'ocean' && frame < 200) {
        for (let i = 0; i < 2; i++) particles.push(make('bubble', rand(0, w), h + 20, 0, -rand(1, 2.4), rand(6, 16)));
      }
      if (style === 'sunset' && frame < 220 && frame % 7 === 1) {
        const rocket = make('rocket', rand(w * 0.1, w * 0.9), h + 10, rand(-1.5, 1.5), -rand(3.5, 5), rand(9, 13));
        rocket.target = rand(h * 0.2, h * 0.4);
        particles.push(rocket);
      }

      const next: Particle[] = [];
      for (const p of particles) {
        switch (p.kind) {
          case 'piece': {
            p.vy += 0.06;
            p.vx *= 0.996;
            p.x += p.vx;
            p.y += p.vy;
            p.rot += p.vr;
            if (p.y > h + 40) p.life = 0;
            break;
          }
          case 'heart': {
            p.x += Math.sin(frame * 0.05 + p.phase) * 0.8;
            p.y += p.vy;
            p.rot = Math.sin(frame * 0.04 + p.phase) * 0.35;
            if (p.y > h + 40) p.life = 0;
            break;
          }
          case 'bubble': {
            p.x += Math.sin(frame * 0.08 + p.phase) * 0.6;
            p.y += p.vy;
            if (p.y < -40) p.life = 0;
            break;
          }
          case 'rocket': {
            p.x += p.vx;
            p.y += p.vy;
            /* Point the nose along the flight path, so diagonal rockets look like they are flying. */
            p.rot = Math.atan2(p.vx, -p.vy);
            if (frame % 2 === 0) next.push({ ...make('trail', p.x + rand(-2, 2), p.y + p.size * 1.2, 0, rand(0.3, 0.9), rand(2, 4), '#fde68a'), life: 22 });
            if (p.y <= p.target) {
              explode(p);
              p.life = 0;
            }
            break;
          }
          case 'spark':
          case 'trail': {
            p.vx *= 0.96;
            p.vy = p.vy * 0.96 + (p.kind === 'spark' ? 0.06 : 0);
            p.x += p.vx;
            p.y += p.vy;
            p.life -= 1;
            break;
          }
        }
        if (p.life > 0) next.push(p);
      }
      particles = next;

      for (const p of particles) {
        ctx!.save();
        ctx!.translate(p.x, p.y);
        ctx!.rotate(p.rot);
        ctx!.globalAlpha = 0.92;
        ctx!.fillStyle = p.color;
        if (p.kind === 'piece') {
          if (p.shape === 0) ctx!.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          else if (p.shape === 1) {
            ctx!.beginPath();
            ctx!.arc(0, 0, p.size / 2, 0, Math.PI * 2);
            ctx!.fill();
          } else {
            ctx!.beginPath();
            ctx!.moveTo(0, -p.size / 2);
            ctx!.lineTo(p.size / 2, p.size / 2);
            ctx!.lineTo(-p.size / 2, p.size / 2);
            ctx!.closePath();
            ctx!.fill();
          }
        } else if (p.kind === 'heart') {
          drawHeart(ctx!, p.size);
        } else if (p.kind === 'bubble') {
          drawBubble(ctx!, p.size, p.color);
        } else if (p.kind === 'rocket') {
          drawRocket(ctx!, p.size, p.color, Math.sin(frame * 0.6 + p.phase) * 0.2);
        } else {
          /* Sparks twinkle as they fade. */
          const twinkle = p.kind === 'spark' ? 0.6 + 0.4 * Math.sin(frame * 0.5 + p.phase) : 1;
          ctx!.globalAlpha = Math.max(0, p.life / (p.kind === 'spark' ? 60 : 22)) * twinkle;
          ctx!.beginPath();
          ctx!.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx!.fill();
        }
        ctx!.restore();
      }

      /* Stop once the spawn window is over and everything has left the screen. */
      if (frame > 200 && particles.length === 0) {
        ctx!.clearRect(0, 0, w, h);
        return;
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
  }, [style]);

  return <canvas ref={ref} className="fr-confetti" aria-hidden="true" />;
}
