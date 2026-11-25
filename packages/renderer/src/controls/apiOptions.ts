import { mapApiOptions } from '@form/logic';
import type { ApiOptions, ChoiceOption } from '@form/schema';
import { buildApiRequest, parseApiBody } from './apiValidation.ts';

export { collectionLabel, displayOptionPath, guessMapping, mapApiOptions, parseResponsePath, pickFromTree } from '@form/logic';
export type { TreePick } from '@form/logic';

export async function fetchApiOptions(config: ApiOptions): Promise<ChoiceOption[]> {
  if (config.itemsPath === undefined) return [];
  try {
    const { url, init } = buildApiRequest(config);
    const res = await fetch(url, init);
    const text = await res.text();
    const parsed = text ? parseApiBody(text, config.parser ?? 'json') : { data: undefined };
    return mapApiOptions(parsed.data, config);
  } catch {
    return [];
  }
}
