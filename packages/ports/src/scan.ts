import type { ByteStream, IsoInstant } from './common.ts';

export interface ScanMeta {
  fileId: string;
  bytes: number;
  contentType?: string;
  filename?: string;
}

/**
 * `skipped` comes only from a scanner that does not inspect content (`AV_DRIVER=none`); it never counts as
 * clean, so a missing engine cannot release a file that requires a scan.
 */
export type ScanVerdict = 'clean' | 'infected' | 'error' | 'skipped';

export interface ScanResult {
  verdict: ScanVerdict;
  signature?: string;
  engineVersion: string;
}

export interface ScannerHealth {
  ok: boolean;
  engineVersion: string;
  signaturesUpdatedAt?: IsoInstant;
}

/** Consumes the whole stream in every case, so a tee feeding the scanner never stalls. */
export interface AVScanner {
  scan(stream: ByteStream, meta: ScanMeta): Promise<ScanResult>;
  health(): Promise<ScannerHealth>;
}
