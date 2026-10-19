import type { Catalogs } from '@form/i18n';
import type {
  Answers, BlockId, EndingId, FieldError, FileRef, FormVersionId, IsoInstant, Locale, PageId, RuntimeFormVersion, RuntimeStatus, SafeUrl,
  SubmissionRequest, SubmitResult, Theme,
} from '@form/schema';

/** What the renderer hands to `uploader`: a file a respondent picked, or the PNG of a signature. */
export interface UploadRequest {
  blockId: BlockId;
  purpose: 'file' | 'signature';
  file: Blob;
  name: string;
}

/** Stores the file (presigned upload in the runtime, local in the builder preview) and returns its reference (S10). */
export type Uploader = (request: UploadRequest) => Promise<FileRef>;

/** The submission body the renderer builds; the host adds the idempotency key, tokens and any verification it runs. */
export type SubmitPayload = Pick<SubmissionRequest, 'formVersionId' | 'locale' | 'answers' | 'pageTrail' | 'client'>;

/** Nothing (or `undefined`) means accepted: the renderer shows the ending its own evaluation chose. */
export type SubmitHandler = (payload: SubmitPayload) => Promise<SubmitResult | void> | SubmitResult | void;

export interface PartialSave {
  formVersionId: FormVersionId;
  answers: Answers;
  currentPageId: PageId;
}

/**
 * Everything the renderer reports; the host decides what follows (analytics, toasts, navigation). The renderer never
 * navigates: on `redirect` the host goes to `url` (always `https:`) after `delayMs`. No event carries a password.
 */
export type RendererEvent =
  | { type: 'start' }
  | { type: 'page'; pageId: PageId; index: number }
  | { type: 'invalid'; errors: FieldError[] }
  | { type: 'submitted'; endingId: EndingId }
  | { type: 'submit_failed'; result: Exclude<SubmitResult, { ok: true }> | { ok: false; kind: 'error' } }
  | { type: 'redirect'; url: SafeUrl; delayMs: number }
  | { type: 'unlock' }
  | { type: 'restart' };

/** Per-session inputs, fixed when the session starts (schema §19 EvalMeta). */
export interface RendererSession {
  /**
   * `meta.now`; defaults to the time the renderer mounted, and for "Submit another response" to the time of the
   * restart (a new session). Pass it for SSR so server and client agree; a passed value also holds after a restart.
   */
  startedAt?: IsoInstant;
  /** Seeds option shuffling for the session so Back keeps the order; defaults to the version id and the session start. */
  shuffleSeed?: string;
  urlParams?: Readonly<Record<string, string>>;
  device?: 'desktop' | 'tablet' | 'mobile';
  pageUrl?: string;
  referrer?: string;
  embedOrigin?: string;
}

export interface FormRendererProps {
  version: RuntimeFormVersion;
  mode: 'live' | 'preview';
  /** Usually `version.status`; the host replaces it after `/session` or an unlock. */
  status: RuntimeStatus;
  initialAnswers?: Answers;
  onSubmit: SubmitHandler;
  onPartialSave?: (draft: PartialSave) => void;
  uploader: Uploader;
  locale: Locale;
  /** Catalogues for `locale`; the en-IN source catalogues are always the fallback. */
  messages?: Catalogs;
  /** Overrides the version's theme (builder design preview). */
  theme?: Theme;
  session?: RendererSession;
  onEvent?: (event: RendererEvent) => void;
  /** The password typed on a `password` status screen; the host checks it and replaces `status`. Never log it. */
  onUnlock?: (password: string) => void;
}
