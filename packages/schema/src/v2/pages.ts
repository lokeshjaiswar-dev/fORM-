import type { AssetRef, BlockId, EndingId, FieldKey, FormId, PageId, PdfTemplateId } from './ids.ts';
import type { LabelText, PipeSource, PlainTemplate, RichDoc } from './rich-text.ts';
import type { BrandRef, Origin } from './template-primitives.ts';

/* ═══════════════════════════════════════════════════════════════════════════
 * §8  STRUCTURE: pages, endings, welcome
 *     Normalised: blocks live in a map; pages / sections / groups hold ordered child ids.
 *     Parent links are DERIVED by compile() (single source of truth).
 * ═════════════════════════════════════════════════════════════════════════ */

export interface Page {
  id: PageId;
  /** Builder label; also step title when behavior.navigation.showPageTitles. */
  title?: LabelText;
  children: BlockId[];               // top-level blocks in render order
  nav?: { nextLabel?: LabelText; backLabel?: LabelText; showBack?: boolean; showNext?: boolean }; // FLD-49
  initiallyHidden?: boolean;
  origin?: Origin;
}

export type EndingAction =
  | { kind: 'fill_again'; label?: string; prefill: 'none' | { carryKeys: FieldKey[] } }   // PRE-04
  | { kind: 'download_pdf'; label?: string; pdfTemplateId?: PdfTemplateId }               // RSP-10
  | { kind: 'edit_submission'; label?: string }                                           // RSP-09
  | { kind: 'visit_url'; label: string; url: PlainTemplate }
  | { kind: 'open_form'; label: string; formId: FormId; prefill?: Array<{ toKey: FieldKey; from: PipeSource }> };

/** END-01..04. A redirect URL is interpolated server-side, values URL-encoded, result must be https (S6). */
export type Ending =
  | { id: EndingId; kind: 'message'; name: string; content: RichDoc; actions: EndingAction[]; confetti?: boolean; origin?: Origin }
  | { id: EndingId; kind: 'redirect'; name: string; url: PlainTemplate; delayMs?: number; message?: RichDoc; origin?: Origin };

export interface WelcomeScreen { enabled: boolean; content: RichDoc; image?: AssetRef | BrandRef; startLabel?: string } // DSN-05
