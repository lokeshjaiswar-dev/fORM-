import type { AvailableType } from '@form/registry';
import type { BlockConfigMap, BlockId } from '@form/schema';
import { updateBlock } from '@/state/actions';

type Config = Record<string, unknown>;

/** When set, inspector config edits write here instead of the open form (custom-field editor). */
let sink: ((id: string, config: Config) => void) | null = null;

export function setConfigSink(next: ((id: string, config: Config) => void) | null): void {
  sink = next;
}

function compact(config: Config): Config {
  const out: Config = {};
  for (const [k, v] of Object.entries(config)) if (v !== undefined) out[k] = v;
  return out;
}

/** Applies a config patch to a block, or to the active custom-field editor. */
export function patchBlockConfig(
  block: { id: string; config: object },
  patch: Readonly<Record<string, unknown>>,
): void {
  const next = compact({ ...(block.config as Config), ...patch });
  if (sink) sink(block.id, next);
  else updateBlock(block.id as BlockId, { config: next as BlockConfigMap[AvailableType] });
}
