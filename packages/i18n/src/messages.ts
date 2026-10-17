export const NAMESPACES = ['renderer', 'builder', 'system'] as const;
export type Namespace = (typeof NAMESPACES)[number];

/** `<namespace>:<key>`, e.g. `system:nav.next`. */
export type MessageId<N extends Namespace = Namespace, K extends string = string> = `${N}:${K}`;

/** Flat key → ICU MessageFormat source. */
export type Catalog = Readonly<Record<string, string>>;
export type Catalogs = Readonly<Partial<Record<Namespace, Catalog>>>;

export type MessageIds<N extends Namespace, M extends Record<string, string>> = {
  readonly [K in keyof M & string]: MessageId<N, K>;
};

/**
 * Declares source messages (en-IN) next to the code that uses them and returns their ids.
 * `pnpm i18n:extract` reads these calls statically, so both arguments must be literals.
 */
export function defineMessages<N extends Namespace, const M extends Record<string, string>>(
  namespace: N,
  messages: M,
): MessageIds<N, M> {
  const ids: Record<string, string> = {};
  for (const key of Object.keys(messages)) ids[key] = `${namespace}:${key}`;
  return ids as MessageIds<N, M>;
}

export function isNamespace(value: string): value is Namespace {
  return (NAMESPACES as readonly string[]).includes(value);
}

export function splitMessageId(id: string): { namespace: Namespace; key: string } | null {
  const at = id.indexOf(':');
  if (at < 0) return null;
  const namespace = id.slice(0, at);
  const key = id.slice(at + 1);
  return isNamespace(namespace) && key ? { namespace, key } : null;
}
