import { expectTypeOf, test } from 'vitest';
import type { z } from 'zod';
import * as S from '../src/index.ts';

test('the twin equality assertions detect drift', () => {
  const wrongTitle = S.FormDefinitionSchema.extend({ title: S.FormDefinitionSchema.shape.formId });
  // @ts-expect-error branded detects a changed property
  expectTypeOf<z.infer<typeof wrongTitle>>().branded.toEqualTypeOf<S.FormDefinition>();
  const wrongId = S.FormDefinitionSchema.extend({ defaultEndingId: S.FormDefinitionSchema.shape.formId });
  // @ts-expect-error branded detects a swapped id brand
  expectTypeOf<z.infer<typeof wrongId>>().branded.toEqualTypeOf<S.FormDefinition>();
  const optional = S.AssetRefSchema.extend({ assetId: S.AssetRefSchema.shape.assetId.exactOptional() });
  // @ts-expect-error plain detects optionality
  expectTypeOf<z.infer<typeof optional>>().toEqualTypeOf<S.AssetRef>();
  const loose = S.AssetRefSchema.extend({ alt: S.AssetRefSchema.shape.alt.unwrap().optional() });
  // @ts-expect-error plain detects `| undefined` under exactOptionalPropertyTypes
  expectTypeOf<z.infer<typeof loose>>().toEqualTypeOf<S.AssetRef>();
});
