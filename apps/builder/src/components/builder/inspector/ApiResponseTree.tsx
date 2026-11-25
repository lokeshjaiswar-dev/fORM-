import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { Button } from '@dmacq/ui';
import { t } from '@/i18n';

const M = defineMessages('builder', {
  'inspector.api_tree_help': 'Open a list, open one item, then choose the text people see and the value to store.',
  'inspector.api_tree_help_check': 'Open the result and click the value that means the answer is valid.',
  'inspector.api_tree_items': '{n, plural, one {# item} other {# items}}',
  'inspector.api_tree_item': 'Item {n}',
  'inspector.api_tree_more': '{n, plural, one {# more} other {# more}}',
  'inspector.api_use_label': 'Show as option text',
  'inspector.api_use_value': 'Save as option value',
});

const PREVIEW = 12;

export type TreePart = 'leaf' | 'entryKey' | 'list';

function isLeaf(value: unknown): boolean {
  return value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string';
}

function childPath(parent: string, key: string, index?: number): string {
  if (index !== undefined) return parent ? `${parent}[${index}]` : `[${index}]`;
  return parent ? `${parent}.${key}` : key;
}

function itemTitle(value: unknown, n: number): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const rec = value as Record<string, unknown>;
    for (const key of ['name', 'label', 'title', 'text']) {
      const text = rec[key];
      if (typeof text === 'string' && text.trim()) return text;
    }
  }
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return t(M['inspector.api_tree_item'], { n });
}

function Row({
  depth,
  open,
  expandable,
  onToggle,
  label,
  hint,
  value,
  active,
  actions,
  onLabelClick,
  onValueClick,
}: {
  depth: number;
  open?: boolean | undefined;
  expandable?: boolean | undefined;
  onToggle?: (() => void) | undefined;
  label: string;
  hint?: string | undefined;
  value?: string | undefined;
  active?: boolean | undefined;
  actions?: ReactNode | undefined;
  onLabelClick?: (() => void) | undefined;
  onValueClick?: (() => void) | undefined;
}) {
  return (
    <div className={`rounded-sm ${active ? 'bg-state-hover' : ''}`}>
      <div className="flex min-w-0 items-center gap-2 pr-2 text-sm leading-5" style={{ paddingLeft: 4 + depth * 12 }}>
        {expandable ? (
          <Button type="button" variant="ghost" size="icon-xs" className="size-4 text-muted-foreground" aria-expanded={open} aria-label={label} onClick={onToggle}>
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </Button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <button type="button" className="min-w-0 truncate text-left font-medium leading-5" onClick={onLabelClick ?? onToggle}>
          {label}
        </button>
        {hint ? <span className="shrink-0 text-muted-foreground">{hint}</span> : null}
        {value !== undefined ? (
          <button type="button" className="min-w-0 truncate text-left leading-5 text-muted-foreground" onClick={onValueClick ?? onLabelClick ?? onToggle}>
            {value}
          </button>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-1 pb-1" style={{ paddingLeft: 28 + depth * 12 }}>{actions}</div> : null}
    </div>
  );
}

function Node({
  path,
  name,
  value,
  depth,
  startOpen,
  mode,
  selected,
  onSelect,
  onUse,
}: {
  path: string;
  name: string;
  value: unknown;
  depth: number;
  startOpen?: boolean | undefined;
  mode: 'options' | 'check';
  selected: string | undefined;
  onSelect: (path: string, part: TreePart) => void;
  onUse?: ((role: 'label' | 'value') => void) | undefined;
}) {
  const [open, setOpen] = useState(startOpen ?? false);
  const list = Array.isArray(value);
  const expandable = list || Boolean(value && typeof value === 'object');
  const active = selected === path;
  const showActions = mode === 'options' && selected === path && !expandable && onUse;

  const actions = showActions ? (
    <>
      <Button type="button" variant="ghost" size="xs" onClick={() => onUse('label')}>
        {t(M['inspector.api_use_label'])}
      </Button>
      <Button type="button" variant="ghost" size="xs" onClick={() => onUse('value')}>
        {t(M['inspector.api_use_value'])}
      </Button>
    </>
  ) : null;

  if (isLeaf(value)) {
    return (
      <Row
        depth={depth}
        label={name}
        value={value == null ? '—' : String(value)}
        active={active}
        actions={actions}
        onLabelClick={() => onSelect(path, 'entryKey')}
        onValueClick={() => onSelect(path, 'leaf')}
      />
    );
  }

  const entries = list
    ? (value as unknown[]).slice(0, PREVIEW).map((child, i) => ({
        childPath: childPath(path, '', i),
        label: itemTitle(child, i + 1),
        child,
      }))
    : Object.entries(value as Record<string, unknown>).map(([key, child]) => ({
        childPath: childPath(path, key),
        label: key,
        child,
      }));
  const extra = list ? Math.max(0, (value as unknown[]).length - PREVIEW) : 0;

  return (
    <div>
      <Row
        depth={depth}
        open={open}
        expandable
        onToggle={() => setOpen((v) => !v)}
        label={name}
        hint={list ? t(M['inspector.api_tree_items'], { n: (value as unknown[]).length }) : undefined}
        active={active}
        onLabelClick={() => {
          setOpen(true);
          onSelect(path, 'list');
        }}
      />
      {open
        ? entries.map((entry) => (
            <Node
              key={entry.childPath}
              path={entry.childPath}
              name={entry.label}
              value={entry.child}
              depth={depth + 1}
              mode={mode}
              selected={selected}
              onSelect={onSelect}
              onUse={onUse}
            />
          ))
        : null}
      {open && extra ? (
        <p className="py-0.5 text-[11px] text-muted-foreground" style={{ paddingLeft: 28 + (depth + 1) * 12 }}>
          {t(M['inspector.api_tree_more'], { n: extra })}
        </p>
      ) : null}
    </div>
  );
}

export function ApiResponseTree({
  data,
  mode,
  selected,
  onSelect,
  onUse,
}: {
  data: unknown;
  mode: 'options' | 'check';
  selected?: string | undefined;
  onSelect: (path: string, part: TreePart) => void;
  onUse?: ((role: 'label' | 'value') => void) | undefined;
}) {
  if (data === undefined) return null;
  return (
    <div className="space-y-1">
      <p className="text-sm text-muted-foreground">{t(M[mode === 'check' ? 'inspector.api_tree_help_check' : 'inspector.api_tree_help'])}</p>
      <div className="max-h-72 overflow-auto rounded-md border py-1">
        {isLeaf(data) ? (
          <Row depth={0} label="response" value={String(data)} active={selected === ''} onLabelClick={() => onSelect('', 'leaf')} />
        ) : Array.isArray(data) ? (
          <Node path="" name={t(M['inspector.api_tree_items'], { n: data.length })} value={data} depth={0} startOpen mode={mode} selected={selected} onSelect={onSelect} onUse={onUse} />
        ) : (
          Object.entries(data as Record<string, unknown>).map(([key, child]) => (
            <Node
              key={key}
              path={key}
              name={key}
              value={child}
              depth={0}
              mode={mode}
              selected={selected}
              onSelect={onSelect}
              onUse={onUse}
            />
          ))
        )}
      </div>
    </div>
  );
}
