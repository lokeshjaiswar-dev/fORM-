import { useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { ChevronDown, ChevronsLeft, Search } from 'lucide-react';
import { CATEGORIES, FIELD_CATALOG } from '@/lib/fields';
import type { FieldType } from '@/types/form';
import { addBlock } from '@/state/actions';
import { useDoc } from '@/state/documentStore';
import { useUiStore } from '@/state/uiStore';
import { FieldTile } from '@/components/builder/FieldIcon';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/tooltip';

export function FieldPicker() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const title = useDoc((d) => d.title);
  const [q, setQ] = useState('');

  const filtered = FIELD_CATALOG.filter(
    (f) => !q || f.label.toLowerCase().includes(q.toLowerCase()) || f.category.toLowerCase().includes(q.toLowerCase()),
  );

  return (
    <aside
      className={cn(
        'shrink-0 overflow-hidden bg-[var(--notion-sidebar)] transition-[width] duration-300 ease-out',
        sidebarOpen ? 'w-[252px]' : 'w-0',
      )}
    >
      <div className="flex h-full w-[252px] flex-col">
        <div className="flex items-center gap-1 px-2 pt-2.5">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[6px] px-1.5 py-1 hover:bg-[var(--notion-hover)]"
          >
            <span className="flex size-5 items-center justify-center rounded-[4px] bg-[#2383e2] text-[11px] font-bold text-white">
              F
            </span>
            <span className="truncate text-[14px] font-medium">Form+</span>
            <ChevronDown className="size-3.5 shrink-0 text-[var(--notion-text-faint)]" />
          </button>
          <Tooltip content="Close sidebar">
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-[6px] text-[var(--notion-text-muted)] hover:bg-[var(--notion-hover)]"
              onClick={() => setSidebarOpen(false)}
            >
              <ChevronsLeft className="size-4" />
            </button>
          </Tooltip>
        </div>

        <div className="px-2 pt-1">
          <label className="flex h-[30px] items-center gap-2 rounded-[6px] bg-[rgba(55,53,47,0.06)] px-2 text-[var(--notion-text-muted)]">
            <Search className="size-3.5 shrink-0" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search"
              className="w-full bg-transparent text-[14px] outline-none placeholder:text-[var(--notion-text-faint)]"
            />
          </label>
        </div>

        <div className="mt-3 flex-1 overflow-y-auto px-2 pb-4">
          <p className="mb-1 px-2 text-[11px] font-medium text-[var(--notion-text-faint)]">This form</p>
          <div className="mb-3 flex items-center gap-2 rounded-[6px] bg-[var(--notion-hover)] px-2 py-1">
            <span className="flex size-5 items-center justify-center rounded-[4px] bg-white text-[11px] font-semibold shadow-sm ring-1 ring-[var(--notion-border)]">
              F
            </span>
            <span className="truncate text-[14px]">{title || 'Form title'}</span>
          </div>
          <p className="mb-1 px-2 text-[11px] font-medium text-[var(--notion-text-faint)]">Drag a field onto the form</p>

          {CATEGORIES.map((cat) => {
            const items = filtered.filter((f) => f.category === cat);
            if (!items.length) return null;
            return (
              <div key={cat} className="mb-3">
                <p className="mb-0.5 px-2 py-1 text-[11px] font-medium text-[var(--notion-text-faint)]">{cat}</p>
                {items.map((field) => (
                  <PaletteItem
                    key={field.type}
                    type={field.type}
                    label={field.label}
                    hint={field.description}
                    onClick={() => addBlock(field.type)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

function PaletteItem({
  type,
  label,
  hint,
  onClick,
}: {
  type: FieldType;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `palette-${type}`,
    data: { from: 'palette', type },
  });

  return (
    <Tooltip content={`Drag to add · ${hint}`} side="right" delay={500} className="w-full">
      <button
        type="button"
        ref={setNodeRef}
        onClick={onClick}
        className={cn(
          'flex w-full cursor-grab items-center gap-2 rounded-[6px] px-2 py-[5px] text-left text-[14px] hover:bg-[var(--notion-hover)] active:cursor-grabbing',
          isDragging && 'opacity-40',
        )}
        {...listeners}
        {...attributes}
      >
        <FieldTile type={type} />
        <span className="truncate">{label}</span>
      </button>
    </Tooltip>
  );
}
