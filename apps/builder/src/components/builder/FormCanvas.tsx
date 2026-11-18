import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { GripVertical, Plus, Trash2, X } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { coverPhoto, formTitlePresentation, listFormSections, packRows, pagePhoto, resolveSectionNav, SectionNav, sectionIndexForPage, sectionNavAtStart, stepsFor, submitButtonPresentation, themeCssVars, type FormSection } from '@form/renderer';
import type { BlockId, BlockLayout, FormDefinition, PageId, SectionNav as SectionNavConfig } from '@form/schema';
import { t } from '@/i18n';
import { labelString } from '@/fields/style';
import { addParagraph, endSlot, removePageBreak, setTitle } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { CanvasBlock } from '@/components/builder/CanvasBlock';
import { insertTile } from '@/components/builder/insert';
import { SlashMenu } from '@/components/builder/SlashMenu';
import { EmptyStart } from '@/components/builder/EmptyStart';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/Tooltip';
import { Button } from '@dmacq/ui';
import { SUBMIT_INSPECTOR_ID } from '@/components/builder/SubmitInspector';
import { TITLE_INSPECTOR_ID } from '@/components/builder/TitleInspector';

const M = defineMessages('builder', {
  'canvas.title_placeholder': 'Form title',
  'canvas.insert_placeholder': 'Type ‘/’ to insert blocks',
  'canvas.insert': 'Insert a block',
  'canvas.page_break': 'Page break',
  'canvas.remove_page_break': 'Remove this page break',
  'canvas.delete': 'Delete',
  'canvas.drag': 'Drag to move',
  'canvas.submit': 'Submit button',
  'canvas.submit_settings': 'Open submit button settings',
  'canvas.title_settings': 'Open form title settings',
});

interface Placed {
  id: BlockId;
  span: number;
}

interface CanvasPage {
  id: PageId;
  rows: Placed[][];
}

/**
 * The canvas layout (pages, rows and spans) as a string, so the canvas re-renders only when the structure or a
 * block's layout changes, never while a block's text is typed (FND-13).
 */
function layoutKey(doc: FormDefinition): string {
  return doc.pages.map((p) => `${p.id}:${p.children.map((id) => {
    const b = doc.blocks[id];
    const layout = b && b.type !== 'unsupported' ? b.layout : undefined;
    return `${id}/${layout?.width ?? 'full'}/${layout?.startNewRow ? 1 : 0}`;
  }).join(',')}`).join('\n');
}

/** Stable string so the canvas does not re-render in a loop when section nav objects are rebuilt (FND-13). */
function sectionNavKey(doc: FormDefinition): string {
  const nav = resolveSectionNav(doc);
  if (!nav) return '';
  return JSON.stringify({
    nav,
    sections: listFormSections(doc),
    submit: labelString(doc.behavior.submit.label) || 'Submit',
    pages: doc.pages.map((p) => p.id),
    first: doc.pages[0]?.id ?? '',
  });
}

function parseSectionNav(key: string): { nav: SectionNavConfig; steps: ReturnType<typeof stepsFor> } | null {
  if (!key) return null;
  const parsed = JSON.parse(key) as { nav: SectionNavConfig; sections: FormSection[]; submit: string; pages: PageId[]; first: PageId };
  const idx = sectionIndexForPage(parsed.sections, parsed.pages.map((id) => ({ id })), parsed.first);
  return { nav: parsed.nav, steps: stepsFor(parsed.sections, Math.max(0, idx), parsed.nav, parsed.submit, false) };
}

function parseLayout(key: string): CanvasPage[] {
  return key.split('\n').map((line) => {
    const at = line.indexOf(':');
    const blocks = line.slice(at + 1).split(',').filter(Boolean).map((part) => {
      const [id = '', width = 'full', newRow = '0'] = part.split('/');
      return { id: id as BlockId, layout: { width: width as BlockLayout['width'], ...(newRow === '1' ? { startNewRow: true } : {}) } };
    });
    return { id: line.slice(0, at) as PageId, rows: packRows(blocks).map((row) => row.map(({ block, span }) => ({ id: block.id, span }))) };
  });
}

/** True for a text box, select or contenteditable area: typing there must keep its focus. */
function isTextEntry(target: EventTarget | Element | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]') !== null;
}

export function FormCanvas() {
  const title = useDoc((d) => d.title);
  const titleStyle = useDoc((d) => d.titleStyle);
  const titlePresent = formTitlePresentation(titleStyle);
  const key = useDoc(layoutKey);
  const tokens = useDoc((d) => d.theme.tokens);
  const layout = useDoc((d) => d.theme.layout);
  const submitLabel = useDoc((d) => labelString(d.behavior.submit.label));
  const submit = useDoc((d) => d.behavior.submit);
  const submitAlign = submit.align;
  const submitPresent = submitButtonPresentation(submit, submit.align === 'full');
  const sectionKey = useDoc(sectionNavKey);
  const pages = useMemo(() => parseLayout(key), [key]);
  const sectionSteps = useMemo(() => parseSectionNav(sectionKey), [sectionKey]);
  const sectionPlacement = sectionSteps?.nav.placement ?? 'top';
  const sectionNavStart = Boolean(sectionSteps && sectionNavAtStart(sectionPlacement));
  const ids = useMemo(() => pages.flatMap((p) => p.rows.flat().map((b) => b.id)), [pages]);
  const startBlank = useUiStore((s) => s.startBlank);
  const started = useUiStore((s) => s.started);
  const openInspector = useUiStore((s) => s.openInspector);
  const setActiveBlock = useUiStore((s) => s.setActiveBlock);
  const goToSection = (id: BlockId) => {
    document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveBlock(id);
  };
  const [slashOpen, setSlashOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const insertRef = useRef<HTMLInputElement>(null);
  const insertFocusKey = useUiStore((s) => s.insertFocusKey);
  const seenInsertFocus = useRef(insertFocusKey);
  const activeBlockId = useUiStore((s) => s.activeBlockId);
  const showStart = !started && ids.length === 0 && pages.length === 1;
  const photo = pagePhoto(tokens);
  const cover = coverPhoto(tokens);
  const { setNodeRef, isOver } = useDroppable({ id: 'canvas-drop' });

  useEffect(() => {
    if (showStart) titleRef.current?.focus();
  }, [showStart]);

  useEffect(() => {
    if (showStart) return;
    // Enter on the last field asks for this row while the label editor is still focused.
    const requested = insertFocusKey !== seenInsertFocus.current;
    seenInsertFocus.current = insertFocusKey;
    if (requested) {
      insertRef.current?.focus();
      return;
    }
    // Other clears must not steal focus from a field the author is typing in.
    if (!activeBlockId && !isTextEntry(document.activeElement)) insertRef.current?.focus();
  }, [showStart, insertFocusKey, activeBlockId]);

  const closeSlash = () => {
    setSlashOpen(false);
    setQuery('');
    setDraft('');
  };

  return (
    <div
      ref={setNodeRef}
      data-layout={layout}
      data-label-align={tokens.labelAlign}
      data-density={tokens.density}
      data-input-style={tokens.inputStyle}
      className="fr-root fr-builder-canvas relative h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      style={{
        ...themeCssVars(tokens),
        backgroundColor: isOver ? 'color-mix(in srgb, var(--fr-text) 4%, var(--fr-page))' : 'var(--fr-page)',
        backgroundImage: 'var(--fr-page-image, none)',
        backgroundSize: 'cover',
        color: 'var(--fr-text)',
        fontFamily: 'var(--fr-font)',
        fontSize: 'var(--fr-size)',
      }}
      onClick={(e) => {
        // Clicks inside a field (including the rows of a configurable list) must not clear the selection.
        if (!isTextEntry(e.target)) setActiveBlock(null);
      }}
    >
      <div className="grid min-h-full w-full">
      {photo ? (
        <div
          aria-hidden
          className="pointer-events-none col-start-1 row-start-1 h-full min-h-full w-full"
          style={{
            backgroundImage: `url(${JSON.stringify(photo.url)})`,
            backgroundSize: photo.fit === 'contain' ? 'contain' : photo.fit === 'tile' ? 'auto' : 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: photo.fit === 'tile' ? 'repeat' : 'no-repeat',
          }}
        />
      ) : null}
      <div className="relative col-start-1 row-start-1 flex min-h-full items-start justify-center px-[72px] py-16 pb-24">
        <div
          className="relative h-auto w-full self-start px-[7.5rem] py-12 shadow-[0_16px_48px_rgba(0,0,0,0.10)]"
          style={{
            maxWidth: 'calc(var(--fr-width) + 10rem)',
            backgroundColor: 'var(--fr-surface)',
            borderRadius: layout === 'cards' ? '24px' : 'min(24px, calc(var(--fr-radius) + 10px))',
          }}
        >
        {cover ? (
          <div
            className="pointer-events-none -mx-[7.5rem] -mt-12 mb-8 overflow-hidden"
            style={{
              height: cover.heightPx,
              borderTopLeftRadius: 'inherit',
              borderTopRightRadius: 'inherit',
            }}
          >
            <img alt="" src={cover.url} className="block h-full w-full object-cover" />
          </div>
        ) : null}
        {tokens.progress !== 'none' ? (
          <div className="absolute inset-x-0 top-0 h-1.5 overflow-hidden" style={{ borderTopLeftRadius: 'inherit', borderTopRightRadius: 'inherit' }} aria-hidden>
            <div className="h-full w-full bg-[color-mix(in_srgb,var(--fr-text)_10%,transparent)]">
              <div className="h-full w-1/3" style={{ backgroundColor: 'var(--fr-accent)' }} />
            </div>
          </div>
        ) : null}
        <div
          className="fr-form-main"
          data-section-placement={sectionSteps ? sectionPlacement : undefined}
          style={sectionSteps?.nav.color ? { ['--fr-section-color' as string]: sectionSteps.nav.color } : undefined}
        >
        {sectionNavStart && sectionSteps ? <SectionNav steps={sectionSteps.steps} nav={sectionSteps.nav} onSelect={goToSection} /> : null}
        <div className="fr-form-body">
        <div
          className="mb-8 rounded-md"
          style={titlePresent.headerStyle}
          onClick={(e) => {
            e.stopPropagation();
            openInspector(TITLE_INSPECTOR_ID);
          }}
        >
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onClick={(e) => {
              e.stopPropagation();
              openInspector(TITLE_INSPECTOR_ID);
              e.currentTarget.select();
            }}
            onFocus={(e) => {
              openInspector(TITLE_INSPECTOR_ID);
              if (e.currentTarget.value) e.currentTarget.select();
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (showStart) startBlank();
              else insertRef.current?.focus();
            }}
            placeholder={t(M['canvas.title_placeholder'])}
            aria-label={t(M['canvas.title_placeholder'])}
            className={cn(
              'w-full border-0 bg-transparent text-[40px] font-bold leading-[1.15] tracking-[-0.02em] shadow-none outline-none placeholder:text-[color-mix(in_srgb,var(--fr-text)_35%,transparent)]',
              !titleStyle?.align && 'text-left',
              titleStyle?.align === 'center' && 'text-center',
              titleStyle?.align === 'right' && 'text-right',
            )}
            style={{
              color: titlePresent.style.color ?? 'var(--fr-text)',
              fontFamily: 'var(--fr-heading-font)',
              fontSize: titlePresent.style.fontSize,
              fontWeight: titlePresent.style.fontWeight ?? 700,
            }}
          />
        </div>

        {showStart ? (
          <EmptyStart />
        ) : (
          <>
            <SortableContext items={ids} strategy={rectSortingStrategy}>
              <div className="flex flex-col" style={{ gap: 'var(--fr-gap)' }}>
                {pages.map((page, p) => (
                  <Fragment key={page.id}>
                    {p > 0 ? <PageBreak pageId={page.id} /> : null}
                    {page.rows.map((row) => (
                      <div key={row.map((b) => b.id).join('-')} className="flex w-full items-start gap-3">
                        {row.map((b) => (
                          <CanvasBlock key={b.id} id={b.id} span={b.span} share={row.length > 1} />
                        ))}
                        {row.length === 1 && row[0] && row[0].span < 12 ? <BesideDrop hostId={row[0].id} /> : null}
                      </div>
                    ))}
                  </Fragment>
                ))}
              </div>
            </SortableContext>

            <div className="relative mt-2" onClick={(e) => e.stopPropagation()}>
              <div className="absolute right-full top-0 flex h-8 items-center text-[#b8b8b8]">
                <Tooltip content={t(M['canvas.delete'])} side="top">
                  <Button type="button" variant="ghost" size="icon-xs" aria-label={t(M['canvas.delete'])} className="text-icon-muted hover:text-destructive" disabled>
                    <Trash2 className="size-3.5" />
                  </Button>
                </Tooltip>
                <Tooltip content={t(M['canvas.insert'])} shortcut="/" side="top">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t(M['canvas.insert'])}
                    className="text-icon-muted"
                    onClick={() => {
                      setSlashOpen(true);
                      insertRef.current?.focus();
                    }}
                  >
                    <Plus className="size-3.5" />
                  </Button>
                </Tooltip>
                <Tooltip content={t(M['canvas.drag'])} side="top">
                  <span className="flex size-6 items-center justify-center">
                    <GripVertical className="size-3.5" />
                  </span>
                </Tooltip>
              </div>
              <div className="relative min-w-0">
                <input
                  ref={insertRef}
                  value={draft}
                  onChange={(e) => {
                    const value = e.target.value;
                    setDraft(value);
                    if (value.startsWith('/')) {
                      setSlashOpen(true);
                      setQuery(value.slice(1));
                    } else {
                      setSlashOpen(false);
                      setQuery('');
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && draft && !draft.startsWith('/')) {
                      e.preventDefault();
                      addParagraph(draft);
                      setDraft('');
                    }
                  }}
                  placeholder={t(M['canvas.insert_placeholder'])}
                  aria-label={t(M['canvas.insert_placeholder'])}
                  className="h-8 w-full border-0 bg-transparent text-[16px] leading-8 shadow-none outline-none placeholder:text-[#c5c4c1]"
                />
                <SlashMenu
                  open={slashOpen}
                  query={query}
                  onQueryChange={(q) => {
                    setQuery(q);
                    setDraft(`/${q}`);
                  }}
                  onClose={closeSlash}
                  onSelect={(tile) => {
                    insertTile(tile, endSlot());
                    closeSlash();
                  }}
                />
              </div>
            </div>

            <div
              className="fr-nav mt-6 rounded-md"
              data-align={submitAlign}
              onClick={(e) => {
                e.stopPropagation();
                openInspector(SUBMIT_INSPECTOR_ID);
              }}
            >
              <button
                type="button"
                aria-label={t(M['canvas.submit_settings'])}
                className={cn(submitPresent.className, 'inline-flex items-center gap-2 font-medium', submitAlign === 'full' && 'justify-center')}
                style={submitPresent.style}
                data-submit-size={submitPresent['data-submit-size']}
                data-submit-shape={submitPresent['data-submit-shape']}
              >
                {submitLabel || t(M['canvas.submit'])}
              </button>
            </div>
          </>
        )}
        </div>
        {sectionSteps && !sectionNavStart ? <SectionNav steps={sectionSteps.steps} nav={sectionSteps.nav} onSelect={goToSection} /> : null}
        </div>
        </div>
      </div>
      </div>
    </div>
  );
}

/** The break before page `pageId`; removing it merges the page into the one before. */
function PageBreak({ pageId }: { pageId: PageId }) {
  return (
    <div className="group/page flex items-center gap-3 py-2 text-[12px] uppercase tracking-wide text-muted-foreground" role="separator" aria-label={t(M['canvas.page_break'])}>
      <span className="h-px flex-1 bg-border" />
      {t(M['canvas.page_break'])}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t(M['canvas.remove_page_break'])}
        className="opacity-0 group-hover/page:opacity-100 focus:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          removePageBreak(pageId);
        }}
      >
        <X className="size-3" />
      </Button>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function BesideDrop({ hostId }: { hostId: BlockId }) {
  const { setNodeRef, isOver } = useDroppable({ id: `beside-${hostId}` });
  return <div ref={setNodeRef} className={cn('min-h-[72px] w-1/2 self-stretch rounded-md', isOver && 'bg-state-hover')} />;
}
