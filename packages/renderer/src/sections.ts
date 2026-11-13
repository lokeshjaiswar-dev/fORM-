import { DEFAULT_SECTION_NAV, type BlockId, type FormDefinition, type PageId, type PublicFormDefinition, type SectionNav, type SectionNavPlacement } from '@form/schema';

export interface FormSection {
  id: BlockId;
  name: string;
  pageId: PageId;
}

type Def = Pick<FormDefinition | PublicFormDefinition, 'pages' | 'blocks' | 'behavior'>;

const SUBMIT_ID = '__submit' as BlockId;
/** Sentinel for the builder title inspector (not a real block). */
export const TITLE_SECTION_ID = '__form_title' as BlockId;

export function resolveSectionNav(def: Def): SectionNav | null {
  const raw = def.behavior.sectionNav;
  if (!raw?.enabled) return null;
  if (listFormSections(def).length === 0) return null;
  const nav = { ...DEFAULT_SECTION_NAV, ...raw };
  if (nav.mode === 'scroll') nav.clickable = true;
  nav.sticky = false;
  return nav;
}

export function sectionNavAtStart(placement: SectionNavPlacement): boolean {
  return placement === 'top' || placement === 'top_left' || placement === 'top_right' || placement === 'left';
}

export function listFormSections(def: Def): FormSection[] {
  const out: FormSection[] = [];
  const visit = (ids: readonly BlockId[], pageId: PageId) => {
    for (const id of ids) {
      const block = def.blocks[id];
      if (!block || block.type === 'unsupported') continue;
      if (block.type === 'section_break' && block.config.showInNav !== false) {
        out.push({ id, name: block.config.name.trim() || 'Section', pageId });
      }
      if ((block.type === 'section' || block.type === 'repeating_group') && 'children' in block.config) {
        visit(block.config.children, pageId);
      }
    }
  };
  for (const page of def.pages) visit(page.children, page.id);
  return out;
}

/** First section on this page, otherwise the last section on an earlier page; `-1` if none yet. */
export function sectionIndexForPage(sections: readonly FormSection[], pages: readonly { id: PageId }[], pageId: PageId): number {
  const order = pages.map((p) => p.id);
  const at = order.indexOf(pageId);
  let earlier = -1;
  let firstOnPage = -1;
  sections.forEach((section, i) => {
    const p = order.indexOf(section.pageId);
    if (p >= 0 && p < at) earlier = i;
    if (p === at && firstOnPage === -1) firstOnPage = i;
  });
  return firstOnPage !== -1 ? firstOnPage : earlier;
}

export const SUBMIT_SECTION_ID = SUBMIT_ID;
