import type { FormDefinition, PageId } from '@form/schema';
import { dropTarget } from '@/state/commands/rules';

/*
 * Pages are structure in v2 (`definition.pages`), not blocks. The builder shows a page break between pages: inserting
 * one splits a page, deleting one merges the page after it into the page before.
 */

/** Splits page `pageId` before its `index`-th block: the blocks from there move to a new page right after it. */
export function splitPage(doc: FormDefinition, pageId: PageId, index: number, newPageId: PageId): void {
  const at = doc.pages.findIndex((p) => p.id === pageId);
  const page = doc.pages[at];
  if (!page) return;
  const moved = page.children.splice(index);
  doc.pages.splice(at + 1, 0, { id: newPageId, children: moved });
}

/** Merges page `pageId` into the page before it; actions that show, hide or skip to or from it are dropped. */
export function mergePage(doc: FormDefinition, pageId: PageId): void {
  const at = doc.pages.findIndex((p) => p.id === pageId);
  const page = doc.pages[at];
  const previous = doc.pages[at - 1];
  if (!page || !previous) return;
  previous.children.push(...page.children);
  doc.pages.splice(at, 1);
  dropTarget(doc, pageId);
}
