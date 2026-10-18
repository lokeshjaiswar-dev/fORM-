export type _ExactKeys<A, B> = [Exclude<keyof A, B>, Exclude<B, keyof A>] extends [never, never] ? true : never;
