import { sql, type SQL, type SQLChunk } from 'drizzle-orm';
import type { Executor } from './client.ts';

/** The shape of `@form/ports` `SqlExecutor` (db does not depend on ports): one statement with `$n` parameters. */
export interface TextSqlExecutor {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** Quoted strings, quoted identifiers and dollar-quoted bodies are skipped; group 2 is a `$n` parameter. */
const TOKENS = /'(?:[^']|'')*'|"(?:[^"]|"")*"|(\$[A-Za-z_]*\$)[\s\S]*?\1|\$(\d+)/g;

/** `$n` text and its values as one Drizzle query; each value stays a bound parameter. */
export function textSql(text: string, values: readonly unknown[] = []): SQL {
  const chunks: SQLChunk[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKENS)) {
    if (m[2] === undefined) continue;
    const n = Number(m[2]);
    if (n < 1 || n > values.length) throw new RangeError(`textSql: $${n} has no value (${values.length} given)`);
    chunks.push(sql.raw(text.slice(last, m.index)), sql.param(values[n - 1]));
    last = m.index + m[0].length;
  }
  chunks.push(sql.raw(text.slice(last)));
  return sql.join(chunks);
}

/**
 * Runs text statements on a Drizzle transaction, so a queue send inside `withTenant` commits or rolls back with
 * the business change (architecture §2.5, the transactional outbox).
 */
export function txExecutor(tx: Executor): TextSqlExecutor {
  return {
    async executeSql(text, values = []) {
      const { rows } = await tx.execute(textSql(text, values));
      return { rows };
    },
  };
}
