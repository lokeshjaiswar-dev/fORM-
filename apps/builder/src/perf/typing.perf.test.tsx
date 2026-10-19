import { describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import type { BlockId, StoredBlock } from '@form/schema';
import { updateBlock } from '@/state/actions';
import { setHistoryClock } from '@/state/history';
import { inlineDoc } from '@/lib/definition';
import { block, resetStore } from '@/test/fixtures';
import { renderCanvas } from '@/test/canvas';
import { renders, resetRenders } from '@/test/profiler';

vi.mock('@/components/builder/CanvasBlock', async (original) => {
  const real = await original<typeof import('@/components/builder/CanvasBlock')>();
  const { profiledCanvasBlock } = await import('@/test/profiler');
  return { CanvasBlock: profiledCanvasBlock(real.CanvasBlock) };
});

/*
 * WP-0.11b acceptance: in a 200-block form, typing commits in < 16 ms p95 and only the edited block re-renders.
 * This runs on its own (`pnpm test:perf`: no coverage, one file at a time) and measures a keystroke as the builder
 * runs it: the command (validated, applied, recorded in history) and React's commit of the canvas, in jsdom. jsdom
 * is slower and noisier than a browser, so the run takes the best p95 of TRIALS runs (as the logic benchmark does)
 * and the CI threshold is the target times FORM_PERF_SLACK (default 4); the best p95 is printed against the 16 ms
 * target. Re-render isolation is asserted exactly, on every keystroke of every trial.
 */

const TARGET_MS = 16;
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const SLACK = Number(env['FORM_PERF_SLACK'] ?? '4') || 4;
const KEYSTROKES = 120;
const WARMUP = 20;
const TRIALS = 5;

function form(): StoredBlock[] {
  const kinds = ['short_text', 'email', 'long_text', 'number', 'single_choice', 'multi_choice', 'date', 'rating', 'heading', 'paragraph'] as const;
  return Array.from({ length: 200 }, (_, i) => {
    const kind = kinds[i % kinds.length] as (typeof kinds)[number];
    return block(kind, `b${i}`, kind === 'heading' || kind === 'paragraph' ? {} : { label: `Question ${i}` });
  });
}

const p95 = (samples: number[]) => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1] ?? Number.NaN;

describe('typing in a 200-block form', () => {
  it(`commits a keystroke in < ${TARGET_MS} ms p95 (CI: × ${SLACK}) and re-renders only the edited block`, () => {
    let clock = 0;
    setHistoryClock(() => clock);
    resetStore(form());
    renderCanvas();
    const target = 'b100' as BlockId;
    const trials: number[] = [];
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const samples: number[] = [];
      let text = `Question 100 ${trial}`;
      for (let i = 0; i < WARMUP + KEYSTROKES; i += 1) {
        text += String.fromCharCode(97 + (i % 26));
        clock += 50;
        resetRenders();
        const start = performance.now();
        act(() => {
          updateBlock(target, { label: inlineDoc(text) });
        });
        const elapsed = performance.now() - start;
        if (i >= WARMUP) samples.push(elapsed);
        expect([...renders.keys()]).toEqual([target]);
      }
      trials.push(p95(samples));
    }
    const measured = Math.min(...trials);
    console.log(`typing p95 ${measured.toFixed(2)} ms, best of ${trials.map((t) => t.toFixed(1)).join(' / ')} over ${KEYSTROKES} keystrokes each (target ${TARGET_MS} ms, CI limit ${TARGET_MS * SLACK} ms)`);
    expect(measured).toBeLessThan(TARGET_MS * SLACK);
  });
});
