import { memo, useState, type ReactNode } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Copy, GripVertical, Plus, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import type { BlockId } from '@form/schema';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';
import { duplicateBlock, requestDeleteBlock, slotAfter } from '@/state/actions';
import { useBlock } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { insertTile } from '@/components/builder/insert';
import { EditBlock } from '@/components/blocks/EditBlock';
import { SlashMenu } from '@/components/builder/SlashMenu';
import { Button } from '@dmacq/ui';
import { Tooltip } from '@/components/ui/tooltip';

const M = defineMessages('builder', {
  'block.delete': 'Delete block',
  'block.duplicate': 'Duplicate block',
  'block.insert': 'Insert block',
  'block.drag': 'Drag to reorder · click for settings',
});

/**
 * One block on the canvas. It reads its own block from the store (a per-block selector) and is memoised on its id,
 * so typing in one block re-renders that block only (FND-13).
 */
export const CanvasBlock = memo(function CanvasBlock({ id, span, share }: { id: BlockId; span: number; share: boolean }) {
  const block = useBlock(id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, data: { type: 'block' } });
  const selected = useUiStore((s) => s.activeBlockId === id);
  const openInspector = useUiStore((s) => s.openInspector);
  const [menuOpen, setMenuOpen] = useState(false);
  const [query, setQuery] = useState('');
  if (!block) return null;

  return (
    <div
      ref={setNodeRef}
      data-block-id={id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('group min-w-0 py-1', span >= 12 ? 'w-full' : share ? 'min-w-0 flex-1' : 'w-1/2', isDragging && 'opacity-40')}
      onClick={(e) => {
        e.stopPropagation();
        openInspector(id);
      }}
    >
      <div className="relative">
        <div
          className={cn(
            'absolute right-full top-0 flex h-8 items-center text-[#b8b8b8] transition-opacity',
            selected || menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          <IconBtn label={t(M['block.delete'])} danger onClick={() => requestDeleteBlock(id)}>
            <Trash2 className="size-3.5" />
          </IconBtn>
          <IconBtn label={t(M['block.duplicate'])} onClick={() => duplicateBlock(id)}>
            <Copy className="size-3.5" />
          </IconBtn>
          <div className="relative">
            <IconBtn
              label={t(M['block.insert'])}
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
              onSelect={(tile) => {
                insertTile(tile, slotAfter(id));
                setMenuOpen(false);
                setQuery('');
              }}
            />
          </div>
          <Tooltip content={t(M['block.drag'])} side="top">
            <button
              type="button"
              aria-label={t(M['block.drag'])}
              className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded hover:bg-black/5 hover:text-[#6b6b6b]"
              {...attributes}
              {...listeners}
              onClick={(e) => {
                e.stopPropagation();
                openInspector(id);
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
});

function IconBtn({ children, onClick, label, danger }: { children: ReactNode; onClick: () => void; label: string; danger?: boolean }) {
  return (
    <Tooltip content={label} side="top">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        className={danger ? 'text-icon-muted hover:text-destructive' : 'text-icon-muted'}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
      >
        {children}
      </Button>
    </Tooltip>
  );
}
