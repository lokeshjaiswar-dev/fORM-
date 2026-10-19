import { Profiler, type ComponentProps, type ComponentType } from 'react';
import type { CanvasBlock } from '@/components/builder/CanvasBlock';

/** Commits per canvas block id since the last `resetRenders`, and the time React spent in them. */
export const renders = new Map<string, { count: number; ms: number }>();

export function resetRenders(): void {
  renders.clear();
}

/**
 * Wraps the real CanvasBlock in a Profiler per block (tests mock the module with this), so a test can see which
 * blocks re-rendered: a block's Profiler reports a commit whenever anything inside it rendered.
 */
export function profiledCanvasBlock(Real: ComponentType<ComponentProps<typeof CanvasBlock>>) {
  return function ProfiledCanvasBlock(props: ComponentProps<typeof CanvasBlock>) {
    return (
      <Profiler
        id={props.id}
        onRender={(id, _phase, actual) => {
          const seen = renders.get(id) ?? { count: 0, ms: 0 };
          renders.set(id, { count: seen.count + 1, ms: seen.ms + actual });
        }}
      >
        <Real {...props} />
      </Profiler>
    );
  };
}
