import type { CheckedFile } from '@form/db';
import type { Answers } from '@form/schema';
import { ProblemError } from './errors.ts';
import { fileRefsIn } from './validate-submission.ts';

/*
 * File references in a submission. An answer carries a reference to a file the respondent uploaded earlier
 * (`POST /v1/p/:slug/files`): its id, name, type, size and hash. Only the id means anything; the rest is the
 * respondent's copy, and a member opening the response later sees the copy. So the server rewrites every reference
 * from the row the upload route recorded, and refuses a reference that is not what the row says.
 */

/** What a field takes in a reference: `file` an uploaded document (`file_upload`), `signature` the PNG of a pad. */
export type FileKind = 'file' | 'signature';

export interface FileUse {
  /** The field the reference sits in (for a field inside a repeating group, the field's own id). */
  blockId: string;
  kind: FileKind;
  ref: Record<string, unknown>;
}

type RefFn = (ref: Record<string, unknown>, at: { blockId: string; kind: FileKind }) => Record<string, unknown>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function mapAnswer(answer: unknown, blockId: string, fn: RefFn): unknown {
  if (!isRecord(answer)) return answer;
  const value = answer['value'];
  switch (answer['type']) {
    case 'file_upload':
      return Array.isArray(value) ? { ...answer, value: value.map((ref: unknown) => (isRecord(ref) ? fn(ref, { blockId, kind: 'file' }) : ref)) } : answer;
    case 'signature':
      return isRecord(value) && isRecord(value['file']) ? { ...answer, value: { ...value, file: fn(value['file'], { blockId, kind: 'signature' }) } } : answer;
    case 'repeating_group': {
      if (!isRecord(value) || !Array.isArray(value['rows'])) return answer;
      const rows = (value['rows'] as unknown[]).map((row) =>
        isRecord(row) && isRecord(row['values'])
          ? { ...row, values: Object.fromEntries(Object.entries(row['values']).map(([childId, child]) => [childId, mapAnswer(child, childId, fn)])) }
          : row,
      );
      return { ...answer, value: { ...value, rows } };
    }
    default:
      return answer;
  }
}

/** The answers with `fn` applied to every file reference, which it finds where the answer types keep them. */
export function mapFileRefs(values: Answers, fn: RefFn): Answers {
  return Object.fromEntries(Object.entries(values).map(([blockId, answer]) => [blockId, mapAnswer(answer, blockId, fn)])) as Answers;
}

/**
 * Every file reference in the answers with the field it sits in. A reference anywhere else (a `fileId` smuggled into a
 * field that takes no file) cannot be bound to a field, so it is refused.
 */
export function fileUses(values: Answers): FileUse[] {
  const uses: FileUse[] = [];
  mapFileRefs(values, (ref, at) => {
    uses.push({ ...at, ref });
    return ref;
  });
  if (fileRefsIn(values).length !== uses.length) throw new ProblemError('VALIDATION_FAILED', 'A file is named in a place that takes no file.');
  return uses;
}

const BAD_FILE = 'A file in the answers was not uploaded to this form. Upload it again.';

/**
 * The answers with every file reference rewritten from the rows the upload route recorded (`rows`, by id): the name,
 * type, size and hash are the stored ones, the scan state is `skipped` (what the upload route says: nothing scans
 * yet), whatever the respondent typed. Refuses a reference whose file is not in `rows` (never uploaded to this form),
 * whose size or hash differ from the row, that was uploaded for another field, or for another kind of field (a
 * file named as a signature, a signature as a file).
 */
export function bindFileRefs(values: Answers, rows: ReadonlyMap<string, CheckedFile>): Answers {
  return mapFileRefs(values, (ref, at) => {
    const id = typeof ref['fileId'] === 'string' ? ref['fileId'] : '';
    const row = rows.get(id);
    if (!row || row.sizeBytes !== ref['sizeBytes'] || row.sha256 !== ref['sha256']) throw new ProblemError('VALIDATION_FAILED', BAD_FILE);
    if (row.blockId !== at.blockId || row.purpose !== at.kind) {
      throw new ProblemError('VALIDATION_FAILED', 'A file in the answers was uploaded for a different field. Upload it again.');
    }
    return { fileId: row.id, name: row.name, sizeBytes: row.sizeBytes, mime: row.mime, sha256: row.sha256, scan: 'skipped' };
  });
}
