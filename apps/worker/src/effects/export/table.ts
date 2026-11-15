/*
 * What the export job drives, whatever the file format (WP-1.17): a table writer fed batch by batch, over a sink that
 * takes bytes. The format files (`csv.ts`, `xlsx.ts`) implement the writer; `upload.ts` makes the sink.
 */

/** Where encoded bytes go; `write` resolves when the sink can take more (back-pressure). */
export interface ByteSink {
  write(chunk: Uint8Array): Promise<void>;
}

export interface TableWriter {
  /** The header row; call once, first. */
  start(headers: readonly string[]): Promise<void>;
  /** Appends rows (each as long as the header). */
  rows(rows: readonly (readonly string[])[]): Promise<void>;
  /** Everything is written; ends the file. The sink is closed by its owner. */
  finish(): Promise<void>;
}

/**
 * A reason an export cannot be built that retrying will not change. `message` is written to `exports.error`, which the
 * member who asked can read, so it is a fixed sentence: never an answer, a key, a path or a database message.
 */
export class ExportFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ExportFailure';
    this.code = code;
  }
}
