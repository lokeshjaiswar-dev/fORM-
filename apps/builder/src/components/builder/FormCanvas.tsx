import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { ArrowRight, GripVertical, Plus, Trash2, X } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { packRows, themeCssVars } from '@form/renderer';
import type { BlockId, BlockLayout, FormDefinition, PageId } from '@form/schema';
import { t } from '@/i18n';
import { labelString } from '@/fields/style';
import { addParagraph, endSlot, removePageBreak, setTitle } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { useBuilderMode } from '@/pages/useBuilderMode';
import { CanvasBlock } from '@/components/builder/CanvasBlock';
import { insertTile } from '@/components/builder/insert';
import { SlashMenu } from '@/components/builder/SlashMenu';
import { EmptyStart } from '@/components/builder/EmptyStart';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';

const M = defineMessages('builder', {
  'canvas.title_placeholder': 'Form title',
  'canvas.insert_placeholder': 'Type ‘/’ to insert blocks',
  'canvas.insert': 'Insert a block',
  'canvas.page_break': 'Page break',
  'canvas.remove_page_break': 'Remove this page break',
  'canvas.delete': 'Delete',
  'canvas.drag': 'Drag to move',
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

export function FormCanvas() {
  const title = useDoc((d) => d.title);
  const key = useDoc(layoutKey);
  const tokens = useDoc((d) => d.theme.tokens);
  const layout = useDoc((d) => d.theme.layout);
  const submitLabel = useDoc((d) => labelString(d.behavior.submit.label));
  const pages = useMemo(() => parseLayout(key), [key]);
  const ids = useMemo(() => pages.flatMap((p) => p.rows.flat().map((b) => b.id)), [pages]);
  const startBlank = useUiStore((s) => s.startBlank);
  const started = useUiStore((s) => s.started);
  const [, setMode] = useBuilderMode();
  const setActiveBlock = useUiStore((s) => s.setActiveBlock);
  const [slashOpen, setSlashOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);
  const insertRef = useRef<HTMLInputElement>(null);
  const insertFocusKey = useUiStore((s) => s.insertFocusKey);
  const showStart = !started && ids.length === 0 && pages.length === 1;
  const { setNodeRef, isOver } = useDroppable({ id: 'canvas-drop' });

  useEffect(() => {
    if (showStart) titleRef.current?.focus();
  }, [showStart]);

  useEffect(() => {
    if (!showStart) insertRef.current?.focus();
  }, [showStart, insertFocusKey]);

  const closeSlash = () => {
    setSlashOpen(false);
    setQuery('');
    setDraft('');
  };

  return (
    <div
      ref={setNodeRef}
      data-layout={layout}
      className="h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
      style={{
        ...themeCssVars(tokens),
        backgroundColor: isOver ? 'color-mix(in srgb, var(--fr-text) 4%, var(--fr-page))' : 'var(--fr-page)',
        backgroundImage: 'var(--fr-page-image, none)',
        backgroundSize: 'cover',
        color: 'var(--fr-text)',
        fontFamily: 'var(--fr-font)',
        fontSize: 'var(--fr-size)',
      }}
      onClick={() => setActiveBlock(null)}
    >
      <div className="flex min-h-full justify-center px-[72px] py-16 pb-24">
        <div
          className="w-full px-10 py-12 shadow-[0_16px_48px_rgba(0,0,0,0.10)]"
          style={{
            maxWidth: 'var(--fr-width)',
            backgroundColor: 'var(--fr-surface)',
            borderRadius: layout === 'cards' ? '24px' : 'min(24px, calc(var(--fr-radius) + 10px))',
          }}
        >
        <input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (showStart) startBlank();
            else insertRef.current?.focus();
          }}
          placeholder={t(M['canvas.title_placeholder'])}
          aria-label={t(M['canvas.title_placeholder'])}
          className="mb-8 w-full bg-transparent text-left text-[40px] font-bold leading-[1.15] tracking-[-0.02em] outline-none placeholder:text-[color-mix(in_srgb,var(--fr-text)_35%,transparent)]"
          style={{ color: 'var(--fr-text)', fontFamily: 'var(--fr-heading-font)' }}
        />

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
                  <button type="button" aria-label={t(M['canvas.delete'])} className="flex size-6 items-center justify-center rounded hover:bg-red-50 hover:text-red-500" disabled>
                    <Trash2 className="size-3.5" />
                  </button>
                </Tooltip>
                <Tooltip content={t(M['canvas.insert'])} shortcut="/" side="top">
                  <button
                    type="button"
                    aria-label={t(M['canvas.insert'])}
                    className="flex size-6 items-center justify-center rounded hover:bg-black/5 hover:text-[#6b6b6b]"
                    onClick={() => {
                      setSlashOpen(true);
                      insertRef.current?.focus();
                    }}
                  >
                    <Plus className="size-3.5" />
                  </button>
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
                  className="h-8 w-full bg-transparent text-[16px] leading-8 outline-none placeholder:text-[#c5c4c1]"
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

            <button
              type="button"
              onClick={() => setMode('preview')}
              className="mt-6 inline-flex items-center gap-2 px-4 py-2 text-[15px] font-medium"
              style={{ background: 'var(--fr-accent)', color: 'var(--fr-accentText)', borderRadius: 'var(--fr-radius)' }}
            >
              {submitLabel} <ArrowRight className="size-4" />
            </button>
          </>
        )}
        </div>
      </div>
    </div>
  );
}

/** The break before page `pageId`; removing it merges the page into the one before. */
function PageBreak({ pageId }: { pageId: PageId }) {
  return (
    <div className="group/page flex items-center gap-3 py-2 text-[12px] uppercase tracking-wide text-zinc-400" role="separator" aria-label={t(M['canvas.page_break'])}>
      <span className="h-px flex-1 bg-zinc-200" />
      {t(M['canvas.page_break'])}
      <button
        type="button"
        aria-label={t(M['canvas.remove_page_break'])}
        className="flex size-5 items-center justify-center rounded opacity-0 hover:bg-black/5 group-hover/page:opacity-100 focus:opacity-100"
        onClick={(e) => {
          e.stopPropagation();
          removePageBreak(pageId);
        }}
      >
        <X className="size-3" />
      </button>
      <span className="h-px flex-1 bg-zinc-200" />
    </div>
  );
}

function BesideDrop({ hostId }: { hostId: BlockId }) {
  const { setNodeRef, isOver } = useDroppable({ id: `beside-${hostId}` });
  return <div ref={setNodeRef} className={cn('min-h-[72px] w-1/2 self-stretch rounded-md', isOver && 'bg-zinc-50')} />;
}
