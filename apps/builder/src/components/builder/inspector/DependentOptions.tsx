import { useState } from 'react';
import { ChevronDown, ClipboardPaste, ListPlus, Plus, Search, Table2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import type { BlockId, BlockOf, ChoiceOption, FormDefinition, OptionId } from '@form/schema';
import { t } from '@/i18n';
import { labelString } from '@/fields/style';
import { patchBlockConfig } from '@/fields/configSink';
import { APP_IDS, blockOrder, blockText, childrenOf } from '@/lib/definition';
import { importPairs, pasteIntoGroup, type PasteResult } from '@/lib/pasteOptions';
import { cn } from '@/lib/utils';
import { currentDoc, useDoc } from '@/state/documentStore';
import { Button, CheckboxField, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Popover, PopoverContent, PopoverTrigger, Textarea } from '@dmacq/ui';
import { NiceSelect } from '@/components/NiceSelect';
import { Field, ToggleRow } from '@/components/builder/inspector/parts';
import { OptionRow, SortableOptions, type OptionPatch } from '@/components/builder/inspector/OptionList';

/*
 * One vocabulary everywhere: an option list is "linked to" an earlier question, each of that question's answers has a
 * group of options, and options in no group are "shown for every" answer.
 */
const M = defineMessages('builder', {
  'linked.toggle': 'Link to an earlier question',
  'linked.toggle_hint': 'Show different options depending on an earlier answer, like State after Country.',
  'linked.label': 'Linked to',
  'linked.placeholder': 'Select a question',
  'linked.hint': 'Each {parent} answer has its own group of options. Respondents see only the group for the answer they pick.',
  'linked.hint_none': 'Pick the earlier question whose answer decides which options show.',
  'linked.no_candidates': 'Add a choice question above this one first, such as Country before State.',
  'linked.parent_missing': 'The question these options were linked to was deleted. Pick another one or turn this off.',
  'linked.in_group': 'Options inside a configurable list, or linked to a question inside one, cannot follow another answer yet. Turn this off to publish.',
  'linked.untitled': 'Untitled question',
  'linked.untitled_answer': 'Untitled answer',
  'linked.every': 'Shown for every {parent}',
  'linked.orphans': 'Linked to a removed answer',
  'linked.count': '{count, plural, one {# option} other {# options}}',
  'linked.empty': 'No options yet.',
  'linked.add': 'Add',
  'linked.add_to': 'Add an option to {group}',
  'linked.paste': 'Paste list',
  'linked.paste_to': 'Paste a list into {group}',
  'linked.paste_title': 'Paste options into {group}',
  'linked.paste_help': 'One option per line. A name already in the list moves that option into this group instead of adding it twice.',
  'linked.add_existing': 'Add existing',
  'linked.add_existing_to': 'Add existing options to {group}',
  'linked.pick_search': 'Search options',
  'linked.pick_none': 'Every option is already in {group}.',
  'linked.pick_nothing_found': 'No option matches.',
  'linked.pick_apply': '{count, plural, =0 {Add to group} one {Add # option} other {Add # options}}',
  'linked.pick_every': 'Shown for every answer',
  'linked.pick_in': 'In {groups}',
  'linked.unsorted_tip': '{count, plural, one {# option is} other {# options are}} shown for every {parent}. Open a {parent} answer and use Add existing to sort them, or leave them for every answer.',
  'linked.remove': 'Remove {option} from {group}',
  'linked.import': 'Import pairs',
  'linked.import_title': 'Import {parent} and option pairs',
  'linked.import_help': 'Paste two columns from a spreadsheet: the {parent} answer, then the option, one pair per line. A line with one cell is shown for every {parent}.',
  'linked.rows': 'Rows',
  'linked.apply': 'Add options',
  'linked.cancel': 'Cancel',
  'linked.done': '{added, plural, one {# option added} other {# options added}}, {linked, plural, one {# link made} other {# links made}}.',
  'linked.unknown': '{parent} has no answer named {names}, so those rows were skipped.',
  'options.paste_title': 'Paste options',
  'options.paste_help': 'One option per line. Options already in the list are kept.',
});

export type DependentBlock = BlockOf<'single_choice'> | BlockOf<'multi_choice'>;

const isChoice = (block: unknown): block is DependentBlock =>
  !!block && typeof block === 'object' && ((block as { type?: string }).type === 'single_choice' || (block as { type?: string }).type === 'multi_choice');

/** Blocks inside a repeating group (a configurable list), at any depth: each row has its own answer. */
export function repeatingMembers(def: Pick<FormDefinition, 'blocks'>): Set<BlockId> {
  const out = new Set<BlockId>();
  const visit = (id: BlockId) => {
    if (out.has(id)) return;
    out.add(id);
    childrenOf(def.blocks[id]).forEach(visit);
  };
  for (const block of Object.values(def.blocks)) if (block?.type === 'repeating_group') block.config.children.forEach(visit);
  return out;
}

/**
 * Single and multi choice questions placed before `id`: the questions its options may be linked to. Nothing inside a
 * repeating group links or is linked to: the engine reads one answer for the parent, and a list has one per row (review S3).
 */
export function parentCandidates(def: FormDefinition, id: BlockId): DependentBlock[] {
  const order = blockOrder(def);
  const inLists = repeatingMembers(def);
  if (inLists.has(id)) return [];
  return order.slice(0, Math.max(0, order.indexOf(id))).filter((b) => !inLists.has(b)).map((b) => def.blocks[b]).filter(isChoice);
}

/** The question a block's options are linked to, when the block has one and it still exists. */
export function useLinkedParent(block: { type: string; config: object }): DependentBlock | undefined {
  return useDoc((d) => {
    if (block.type !== 'single_choice' && block.type !== 'multi_choice') return undefined;
    const parentId = (block.config as { dependsOn?: BlockId }).dependsOn;
    const parent = parentId ? d.blocks[parentId] : undefined;
    return isChoice(parent) ? parent : undefined;
  });
}

const nameOf = (block: DependentBlock): string => blockText(block) || t(M['linked.untitled']);

/**
 * The switch that turns a plain option list into a linked one. Off by default, so a first-time author sees only the
 * list. Turning it off only unlinks the question: every option keeps its links (they do nothing while unlinked), so
 * turning it back on and picking the same question restores the groups exactly. Linking a different question keeps
 * only the links that name one of its answers.
 */
export function LinkSetting({ block }: { block: DependentBlock }) {
  /* Read the whole document: a selector that built the list would return a new array on every check and never settle. */
  const def = useDoc((d) => d);
  const candidates = parentCandidates(def, block.id);
  const parent = useLinkedParent(block);
  const linked = block.config.dependsOn !== undefined;
  const [opened, setOpened] = useState(linked);
  const on = linked || opened;
  const missing = linked && !parent;
  const inLists = repeatingMembers(def);
  const inList = inLists.has(block.id) || (parent !== undefined && inLists.has(parent.id));
  /* Inside a configurable list there is nothing to link to; a link made before stays visible so it can be turned off. */
  if (inList && !linked) return null;
  const relink = (dependsOn: BlockId) => {
    const next = def.blocks[dependsOn];
    const answers = new Set<string>(isChoice(next) ? next.config.options.map((o) => o.id) : []);
    const options = block.config.options.map((option) => {
      const kept = option.parentOptionIds?.filter((p) => answers.has(p));
      const { parentOptionIds: _old, ...rest } = option;
      return kept?.length ? { ...rest, parentOptionIds: kept } : rest;
    });
    patchBlockConfig(block, { dependsOn, options });
  };
  return (
    <>
      <ToggleRow
        label={t(M['linked.toggle'])}
        hint={on ? undefined : t(M['linked.toggle_hint'])}
        checked={on}
        onChange={(next) => {
          setOpened(next);
          if (!next && linked) patchBlockConfig(block, { dependsOn: undefined });
        }}
      />
      {on && !linked && candidates.length === 0 ? <p className="text-[12px] text-muted-foreground">{t(M['linked.no_candidates'])}</p> : null}
      {on && (linked || candidates.length > 0) ? (
        <Field
          label={t(M['linked.label'])}
          hint={missing ? undefined : parent ? t(M['linked.hint'], { parent: nameOf(parent) }) : t(M['linked.hint_none'])}
          error={missing ? t(M['linked.parent_missing']) : inList ? t(M['linked.in_group']) : undefined}
        >
          <NiceSelect
            size="sm"
            aria-label={t(M['linked.label'])}
            placeholder={t(M['linked.placeholder'])}
            value={parent ? parent.id : ''}
            onChange={(value) => {
              if (value !== '' && value !== block.config.dependsOn) relink(value as BlockId);
            }}
            options={candidates.map((c) => ({ value: c.id, label: nameOf(c) }))}
          />
        </Field>
      ) : null}
    </>
  );
}

/** A text box dialog for pasting many options at once; `apply` returns a note to keep it open, or null to close. */
function PasteDialog({ open, onOpenChange, title, help, apply }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; help: string; apply: (text: string) => string | null }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [shown, setShown] = useState(open);
  /* Each opening starts empty. */
  if (open !== shown) {
    setShown(open);
    if (open) {
      setText('');
      setNote(null);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 p-6 sm:max-w-[480px]">
        <DialogHeader className="space-y-2 pr-6">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{help}</DialogDescription>
        </DialogHeader>
        <Textarea aria-label={t(M['linked.rows'])} rows={10} value={text} onChange={(e) => setText(e.target.value)} className="text-[13px]" />
        {note ? <p className="text-[13px] text-amber-700">{note}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t(M['linked.cancel'])}
          </Button>
          <Button
            type="button"
            disabled={!text.trim()}
            onClick={() => {
              const kept = apply(text);
              if (kept === null) onOpenChange(false);
              else setNote(kept);
            }}
          >
            {t(M['linked.apply'])}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Writes pasted options to the block as it is now (the dialog may have been open while it changed). */
function applyPaste(blockId: BlockId, run: (options: readonly ChoiceOption[]) => PasteResult): PasteResult | null {
  const latest = currentDoc().blocks[blockId];
  if (!isChoice(latest)) return null;
  const result = run(latest.config.options);
  patchBlockConfig(latest, { options: result.options });
  return result;
}

/** "Paste list" for a plain (unlinked) option list: one option per line. */
export function PasteList({ block }: { block: DependentBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => setOpen(true)}>
        <ClipboardPaste className="size-3.5" /> {t(M['linked.paste'])}
      </Button>
      <PasteDialog
        open={open}
        onOpenChange={setOpen}
        title={t(M['options.paste_title'])}
        help={t(M['options.paste_help'])}
        apply={(text) => {
          applyPaste(block.id, (options) => pasteIntoGroup(options, null, text, () => APP_IDS.newId()));
          return null;
        }}
      />
    </>
  );
}

interface Group {
  key: string;
  /** The parent answer this group belongs to; null for options shown for every answer (or linked to removed ones). */
  parentId: OptionId | null;
  title: string;
  items: ChoiceOption[];
}

export interface GroupedOptionsProps {
  block: DependentBlock;
  parent: DependentBlock;
  images: boolean;
  valueColumn: boolean;
  showCode: boolean;
  onEdit: (id: OptionId, patch: OptionPatch) => void;
  /** Deletes an option outright (and everything that named it). */
  onDelete: (id: OptionId) => void;
  onMove: (id: OptionId, over: OptionId) => void;
  /** Appends a new option with the given links and returns its id. */
  onAdd: (parentOptionIds: OptionId[] | undefined) => OptionId;
  /** Puts existing options into a group (one edit, so one undo). */
  onLink: (ids: readonly OptionId[], parentId: OptionId) => void;
}

/**
 * A linked option list, grouped the way authors think about it: each answer of the linked question ("India") with
 * the options that belong to it ("Maharashtra", "Karnataka"), then the options shown for every answer. Options are
 * added, pasted, sorted and removed inside their group; an option in two groups is one option, listed in both.
 */
export function GroupedOptions({ block, parent, images, valueColumn, showCode, onEdit, onDelete, onMove, onAdd, onLink }: GroupedOptionsProps) {
  const options = block.config.options;
  const parentName = nameOf(parent);
  const parentIds = new Set<string>(parent.config.options.map((p) => p.id));
  const groups: Group[] = parent.config.options.map((p) => ({
    key: p.id,
    parentId: p.id,
    title: labelString(p.label) || t(M['linked.untitled_answer']),
    items: options.filter((o) => o.parentOptionIds?.includes(p.id)),
  }));
  groups.push({ key: '__every', parentId: null, title: t(M['linked.every'], { parent: parentName }), items: options.filter((o) => !o.parentOptionIds?.length) });
  const orphans = options.filter((o) => o.parentOptionIds?.length && !o.parentOptionIds.some((p) => parentIds.has(p)));
  if (orphans.length) groups.push({ key: '__orphans', parentId: null, title: t(M['linked.orphans']), items: orphans });

  /* Short lists open in full; long ones (a country's districts) start folded so the panel stays scannable. */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(options.length <= 24 ? groups.map((g) => g.key) : []));
  const [fresh, setFresh] = useState<OptionId | null>(null);
  const [pasteInto, setPasteInto] = useState<Group | null>(null);
  const [importing, setImporting] = useState(false);
  const toggle = (key: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const reveal = (key: string) => setOpen((now) => new Set(now).add(key));

  /** Removing from a group only unlinks an option that other groups still hold. */
  const removeFrom = (group: Group, option: ChoiceOption) => {
    const rest = group.parentId ? (option.parentOptionIds ?? []).filter((p) => p !== group.parentId) : [];
    if (group.parentId && rest.length) onEdit(option.id, { parentOptionIds: rest });
    else onDelete(option.id);
  };

  /* Right after linking, every option is still unsorted: say what to do next instead of leaving empty groups. */
  const unsorted = groups.find((g) => g.key === '__every')?.items.length ?? 0;
  const sorted = options.some((o) => o.parentOptionIds?.some((p) => parentIds.has(p)));
  const groupsOf = (option: ChoiceOption): string =>
    groups.filter((g) => g.parentId !== null && g.items.includes(option)).map((g) => g.title).join(', ');

  return (
    <div className="space-y-2">
      {unsorted > 0 && !sorted ? (
        <p className="rounded-md bg-primary-faded px-2.5 py-2 text-[12px] leading-[18px] text-primary-text">{t(M['linked.unsorted_tip'], { count: unsorted, parent: parentName })}</p>
      ) : null}
      {groups.map((group) => {
        const expanded = open.has(group.key);
        const bodyId = `linked-group-${block.id}-${group.key}`;
        return (
          <section key={group.key} className="rounded-lg border border-border">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={bodyId}
              onClick={() => toggle(group.key)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-state-hover focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ChevronDown aria-hidden className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform duration-150', !expanded && '-rotate-90')} />
              <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', group.parentId === null && 'text-muted-foreground')}>{group.title}</span>
              <span className="shrink-0 text-[12px] tabular-nums text-muted-foreground">{t(M['linked.count'], { count: group.items.length })}</span>
            </button>
            {expanded ? (
              <div id={bodyId} className="space-y-2 border-t border-border px-2.5 pb-2.5 pt-2">
                {group.items.length ? (
                  <SortableOptions ids={group.items.map((o) => o.id)} onMove={onMove}>
                    {group.items.map((option, i) => (
                      <OptionRow
                        key={option.id}
                        option={option}
                        n={options.indexOf(option) + 1}
                        above={group.items[i - 1]?.id}
                        below={group.items[i + 1]?.id}
                        onMove={onMove}
                        images={images}
                        valueColumn={valueColumn}
                        showCode={showCode}
                        autoFocus={option.id === fresh}
                        onEdit={(patch) => onEdit(option.id, patch)}
                        removeLabel={t(M['linked.remove'], { option: labelString(option.label), group: group.title })}
                        removeDisabled={options.length <= 1 && !(group.parentId && (option.parentOptionIds?.length ?? 0) > 1)}
                        onRemove={() => removeFrom(group, option)}
                      />
                    ))}
                  </SortableOptions>
                ) : (
                  <p className="text-[12px] text-muted-foreground">{t(M['linked.empty'])}</p>
                )}
                {group.key === '__orphans' ? null : (
                  /*
                   * Lined up with the rows above: Add and Add existing share the width of the option fields (starting
                   * where the fields start, after the drag handles), and the paste icon sits in the remove column.
                   */
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1 pl-5">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={cn('w-full min-w-0 border-dashed text-muted-foreground hover:text-foreground', group.parentId === null && 'col-span-2')}
                      aria-label={t(M['linked.add_to'], { group: group.title })}
                      onClick={() => {
                        setFresh(onAdd(group.parentId ? [group.parentId] : undefined));
                        reveal(group.key);
                      }}
                    >
                      <Plus className="size-3.5" /> {t(M['linked.add'])}
                    </Button>
                    {group.parentId !== null ? (
                      <AddExisting
                        group={group.title}
                        candidates={options.filter((o) => !group.items.includes(o)).map((o) => ({ option: o, where: groupsOf(o) }))}
                        onAdd={(ids) => {
                          if (group.parentId) onLink(ids, group.parentId);
                        }}
                      />
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      title={t(M['linked.paste'])}
                      aria-label={t(M['linked.paste_to'], { group: group.title })}
                      onClick={() => setPasteInto(group)}
                    >
                      <ClipboardPaste className="size-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            ) : null}
          </section>
        );
      })}
      <Button type="button" variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground" onClick={() => setImporting(true)}>
        <Table2 className="size-3.5" /> {t(M['linked.import'])}
      </Button>

      <PasteDialog
        open={pasteInto !== null}
        onOpenChange={(next) => {
          if (!next) setPasteInto(null);
        }}
        title={t(M['linked.paste_title'], { group: pasteInto?.title ?? '' })}
        help={t(M['linked.paste_help'])}
        apply={(text) => {
          if (!pasteInto) return null;
          applyPaste(block.id, (current) => pasteIntoGroup(current, pasteInto.parentId, text, () => APP_IDS.newId()));
          reveal(pasteInto.key);
          return null;
        }}
      />
      <PasteDialog
        open={importing}
        onOpenChange={setImporting}
        title={t(M['linked.import_title'], { parent: parentName })}
        help={t(M['linked.import_help'], { parent: parentName })}
        apply={(text) => {
          const result = applyPaste(block.id, (current) => importPairs(current, parent.config.options, text, () => APP_IDS.newId()));
          if (!result?.unknownParents.length) return null;
          const names = result.unknownParents.map((n) => `“${n}”`).join(', ');
          return `${t(M['linked.done'], { added: result.added, linked: result.linked })} ${t(M['linked.unknown'], { parent: parentName, names })}`;
        }}
      />
    </div>
  );
}

/**
 * Puts options the block already has into a group, so linking an existing list never means typing it again. Lists
 * every option not yet in the group, with the groups it is already in (an option may belong to several answers).
 */
function AddExisting({ group, candidates, onAdd }: { group: string; candidates: Array<{ option: ChoiceOption; where: string }>; onAdd: (ids: OptionId[]) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<OptionId>>(new Set());
  const needle = query.trim().toLowerCase();
  const shown = needle ? candidates.filter((c) => labelString(c.option.label).toLowerCase().includes(needle)) : candidates;
  const flip = (id: OptionId) =>
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setQuery('');
          setPicked(new Set());
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="w-full min-w-0 text-muted-foreground hover:text-foreground" aria-label={t(M['linked.add_existing_to'], { group })}>
          <ListPlus className="size-3.5" /> {t(M['linked.add_existing'])}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[280px] p-0">
        {candidates.length === 0 ? (
          <p className="px-3 py-3 text-[13px] text-muted-foreground">{t(M['linked.pick_none'], { group })}</p>
        ) : (
          <>
            <div className="border-b border-border p-2">
              <div className="relative">
                <Search aria-hidden className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input autoFocus className="h-8 pl-7 text-[13px]" aria-label={t(M['linked.pick_search'])} placeholder={t(M['linked.pick_search'])} value={query} onChange={(e) => setQuery(e.target.value)} />
              </div>
            </div>
            <ul className="max-h-[260px] overflow-y-auto p-1">
              {shown.map(({ option, where }) => (
                <li key={option.id} className="rounded-md px-2 py-1.5 hover:bg-state-hover">
                  <CheckboxField size="sm" checked={picked.has(option.id)} onCheckedChange={() => flip(option.id)} label={labelString(option.label)} />
                  <p className="pl-6 text-[11px] text-muted-foreground">{where ? t(M['linked.pick_in'], { groups: where }) : t(M['linked.pick_every'])}</p>
                </li>
              ))}
              {shown.length === 0 ? <li className="px-2 py-2 text-[13px] text-muted-foreground">{t(M['linked.pick_nothing_found'])}</li> : null}
            </ul>
            <div className="border-t border-border p-2">
              <Button
                type="button"
                size="sm"
                className="w-full"
                disabled={picked.size === 0}
                onClick={() => {
                  onAdd([...picked]);
                  setOpen(false);
                }}
              >
                {t(M['linked.pick_apply'], { count: picked.size })}
              </Button>
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
