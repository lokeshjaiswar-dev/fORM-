import { describe, expectTypeOf, it } from 'vitest';
import type { BlockType, EmailConfig, FieldDefinition, FieldRegistry, SchemaLike } from '@form/schema';
import { REGISTRY, defineStub, type AvailableType, type StubType } from '../src/index.ts';

describe('FieldRegistry contract', () => {
  it('REGISTRY is the exhaustive mapped type', () => {
    expectTypeOf(REGISTRY).toEqualTypeOf<FieldRegistry>();
    expectTypeOf(REGISTRY.email).toEqualTypeOf<FieldDefinition<'email'>>();
    expectTypeOf<AvailableType | StubType>().toEqualTypeOf<BlockType>();
  });

  it('resolves the conditional members per type', () => {
    expectTypeOf(REGISTRY.heading.answerSchema).toEqualTypeOf<null>();
    expectTypeOf(REGISTRY.rating.isEmpty).toEqualTypeOf<(value: number) => boolean>();
    expectTypeOf(REGISTRY.email.configSchema).toEqualTypeOf<SchemaLike<EmailConfig>>();
  });

  it('rejects a registry with a missing or mistyped entry', () => {
    const { email: _email, ...rest } = REGISTRY;
    // @ts-expect-error a BlockType without an entry
    const missing: FieldRegistry = rest;
    // @ts-expect-error an entry registered under another type's key
    const swapped: FieldRegistry = { ...REGISTRY, email: REGISTRY.url };
    // @ts-expect-error a stub's default config must match its type
    defineStub('rating', 'x-field:rating', () => ({ max: '5' }));
    expectTypeOf(missing).toEqualTypeOf<FieldRegistry>();
    expectTypeOf(swapped).toEqualTypeOf<FieldRegistry>();
  });
});
