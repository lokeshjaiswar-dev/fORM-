import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowRight, GripVertical, Plus, Trash2 } from 'lucide-react';
import { useFormStore } from '@/store/useFormStore';
import { EditBlock } from '@/components/blocks/EditBlock';
import { SlashMenu } from '@/components/builder/SlashMenu';
import { EmptyStart } from '@/components/builder/EmptyStart';
import { TemplateModal } from '@/components/builder/TemplateModal';
import { isHalf, packRows } from '@/lib/layout';
import type { FieldType, FormBlock } from '@/types/form';
import { cn } from '@/lib/utils';
import { escapeHtml } from '@/lib/sanitize';
import { Tooltip } from '@/components/ui/tooltip';

export function FormCanvas() {
  const form = useFormStore((s) => s.form);
  const setTitle = useFormStore((s) => s.setTitle);
  const addBlock = useFormStore((s) => s.addBlock);
  const startBlank = useFormStore((s) => s.startBlank);
  const started = useFormStore((s) => s.started);
  const setMode = useFormStore((s) => s.setMode);
  const setActiveBlock = useFormStore((s) => s.setActiveBlock);
  const [slashOpen, setSlashOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const insertRef = useRef<HTMLInputElement>(null);
  const insertFocusKey = useFormStore((s) => s.insertFocusKey);
  const showStart = !started && form.blocks.length === 0;
  const { setNodeRef, isOver } = useDroppable({ id: 'canvas-drop' });

  useEffect(() => {
    if (showStart) titleRef.current?.focus();
  }, [showStart]);

  useEffect(() => {
    if (!showStart) insertRef.current?.focus();
  }, [showStart, insertFocusKey]);

  function commitSlash(type: FieldType) {
    addBlock(type, form.blocks.length);
    setSlashOpen(false);
    setQuery('');
    setDraft('');
  }

  return (
    <div
      ref={setNodeRef}
      className={cn('min-h-full flex-1 overflow-y-auto overflow-x-hidden bg-white', isOver && 'bg-[#fafafa]')}
      onClick={() => setActiveBlock(null)}
    >
      <div className="mx-auto w-full max-w-[720px] pb-40 pl-[108px] pr-8 pt-[72px]">
        <input
          ref={titleRef}
          value={form.title}
          onChange={(e) => setTitle(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            if (showStart) startBlank();
            else insertRef.current?.focus();
          }}
          placeholder="Form title"
          className="mb-8 w-full bg-transparent text-left text-[40px] font-bold leading-[1.15] tracking-[-0.02em] outline-none placeholder:text-[#c5c4c1]"
        />

        {showStart ? (
          <>
            <EmptyStart onTemplates={() => setTemplatesOpen(true)} />
            <TemplateModal open={templatesOpen} onOpenChange={setTemplatesOpen} />
          </>
        ) : (
          <>
            <SortableContext items={form.blocks.map((b) => b.id)} strategy={rectSortingStrategy}>
              <div className="space-y-1">
                {packRows(form.blocks).map((row) => (
                  <div key={row.map((b) => b.id).join('-')} className="flex w-full items-start gap-3">
                    {row.map((block) => (
                      <SortableBlock key={block.id} block={block} half={isHalf(block)} share={row.length === 2} />
                    ))}
                    {row.length === 1 && isHalf(row[0]) ? <BesideDrop hostId={row[0].id} /> : null}
                  </div>
                ))}
              </div>
            </SortableContext>

            <div className="relative mt-2" onClick={(e) => e.stopPropagation()}>
              <div className="absolute right-full top-0 flex h-8 items-center text-[#b8b8b8]">
                <Tooltip content="Delete" side="top">
                  <button type="button" className="flex size-6 items-center justify-center rounded hover:bg-red-50 hover:text-red-500" disabled>
                    <Trash2 className="size-3.5" />
                  </button>
                </Tooltip>
                <Tooltip content="Insert a block" shortcut="/" side="top">
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded hover:bg-black/5 hover:text-[#6b6b6b]"
                    onClick={() => {
                      setSlashOpen(true);
                      insertRef.current?.focus();
                    }}
                  >
                    <Plus className="size-3.5" />
                  </button>
                </Tooltip>
                <Tooltip content="Drag to move" side="top">
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
                      addBlock('paragraph', form.blocks.length, { label: escapeHtml(draft) });
                      setDraft('');
                    }
                  }}
                  placeholder="Type '/' to insert blocks"
                  className="h-8 w-full bg-transparent text-[16px] leading-8 outline-none placeholder:text-[#c5c4c1]"
                />
                <SlashMenu
                  open={slashOpen}
                  query={query}
                  onQueryChange={(q) => {
                    setQuery(q);
                    setDraft(`/${q}`);
                  }}
                  onClose={() => {
                    setSlashOpen(false);
                    setQuery('');
                    setDraft('');
                  }}
                  onSelect={commitSlash}
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => setMode('preview')}
              className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[#111] px-4 py-2 text-[15px] font-medium text-white"
            >
              {form.settings.submitButtonText} <ArrowRight className="size-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function BesideDrop({ hostId }: { hostId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `beside-${hostId}` });
  return (
    <div
      ref={setNodeRef}
      className={cn('min-h-[72px] w-1/2 self-stretch rounded-md', isOver && 'bg-zinc-50')}
    />
  );
}

function SortableBlock({ block, half, share }: { block: FormBlock; half: boolean; share: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: block.id,
    data: { type: 'block' },
  });
  const form = useFormStore((s) => s.form);
  const activeBlockId = useFormStore((s) => s.activeBlockId);
  const setActiveBlock = useFormStore((s) => s.setActiveBlock);
  const openInspector = useFormStore((s) => s.openInspector);
  const deleteBlock = useFormStore((s) => s.deleteBlock);
  const addBlock = useFormStore((s) => s.addBlock);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = activeBlockId === block.id;
  const index = form.blocks.findIndex((b) => b.id === block.id);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'group min-w-0 py-1',
        half ? (share ? 'min-w-0 flex-1' : 'w-1/2') : 'w-full',
        isDragging && 'opacity-40',
      )}
      onClick={(e) => {
        e.stopPropagation();
        setActiveBlock(block.id);
      }}
    >
      <div className="relative">
        <div
          className={cn(
            'absolute right-full top-0 flex h-8 items-center text-[#b8b8b8] transition-opacity',
            selected || menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          <IconBtn label="Delete block" danger onClick={() => deleteBlock(block.id)}>
            <Trash2 className="size-3.5" />
          </IconBtn>
          <div className="relative">
            <IconBtn
              label="Insert block"
              onClick={() => {
                setMenuOpen((v) => !v);
                setQuery('');
              }}
            >
              <Plus className="size-3.5" />
            </IconBtn>
            <SlashMenu
              open={menuOpen}
              query={query}
              onQueryChange={setQuery}
              onClose={() => setMenuOpen(false)}
              onSelect={(type) => {
                addBlock(type, index + 1);
                setMenuOpen(false);
                setQuery('');
              }}
            />
          </div>
          <Tooltip content="Drag to reorder · click for settings" side="top">
            <button
              type="button"
              className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded hover:bg-black/5 hover:text-[#6b6b6b]"
              {...attributes}
              {...listeners}
              onClick={(e) => {
                e.stopPropagation();
                openInspector(block.id);
              }}
            >
              <GripVertical className="size-3.5" />
            </button>
          </Tooltip>
        </div>
        <div className="min-w-0">
          <EditBlock block={block} />
        </div>
      </div>
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  label,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  return (
    <Tooltip content={label} side="top">
      <button
        type="button"
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded text-[#b8b8b8]',
          danger ? 'hover:bg-red-50 hover:text-red-500' : 'hover:bg-black/5 hover:text-[#6b6b6b]',
        )}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        {children}
      </button>
    </Tooltip>
  );
}
