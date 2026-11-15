import { Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import type { BlockId, ReviewGroupId, ReviewUnit, ReviewUnitAssignment, ReviewVisibility } from '@form/schema';
import { Alert, AlertDescription, Button, Input, Label, Switch } from '@dmacq/ui';
import { t } from '@/i18n';
import { useDraft } from '@/lib/useDraft';
import { NiceSelect } from '@/components/NiceSelect';
import { removeUnit, renameUnit } from '@/components/builder/review/reviewActions';
import { newAssignment, nameText, type UnitProblem } from '@/components/builder/review/reviewModel';
import { MAX_UNIT_NAME } from '@/state/commands/review';
import type { ReviewGroup } from '@/pages/org/orgApi';

const M = defineMessages('builder', {
  'review_unit.name': 'Name of the review unit for {target}',
  'review_unit.delete': 'Delete the review unit for {target}',
  'review_unit.covers': 'Covers {count, plural, one {# block} other {# blocks}}',
  'review_unit.covers_none': 'Covers no blocks',
  'review_unit.blocks': 'Blocks in {target}',
  'review_unit.group': 'Group that checks {target}',
  'review_unit.group_placeholder': 'Choose a group',
  'review_unit.unassign': 'Remove the group of {target}',
  'review_unit.unassign_button': 'Remove group',
  'review_unit.not_assigned': 'No group yet: nobody checks this unit until you choose one.',
  'review_unit.order': 'Order',
  'review_unit.order_for': 'Order for {target}',
  'review_unit.order_invalid': 'Enter a whole number from 1 up.',
  'review_unit.order_hint': 'Units with the same order are checked at the same time. A higher order waits for the lower ones.',
  'review_unit.required': 'Required',
  'review_unit.required_for': 'Required for {target}',
  'review_unit.visibility': 'The checker sees',
  'review_unit.visibility_for': 'What the checker of {target} sees',
  'review_unit.visibility_own': 'Only this unit',
  'review_unit.visibility_whole': 'The whole response',
});

const FIELD = 'border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground';

export interface UnitCardProps {
  unit: ReviewUnit;
  target: { label: string; gone: boolean };
  /** What `reviewUnitMembership` says the unit covers, with a label for each block. */
  blocks: ReadonlyArray<{ id: BlockId; label: string }>;
  problems: readonly UnitProblem[];
  assignment: ReviewUnitAssignment | undefined;
  /** The org's unarchived review groups; null when they could not be read. */
  groups: readonly ReviewGroup[] | null;
  /** The assignment controls are off: the form is not on the server, or the settings are not loaded. */
  locked: boolean;
  /** What is wrong with the assignment (a group that is gone, an order that is not a number), in words. */
  assignmentProblem: string | undefined;
  onAssign: (next: ReviewUnitAssignment | null) => void;
}

/** One review unit: its name, what it covers, what is wrong with it, and who checks it. */
export function UnitCard({ unit, target, blocks, problems, assignment, groups, locked, assignmentProblem, onAssign }: UnitCardProps) {
  const stored = nameText(unit.name);
  const [name, setName] = useDraft(stored);
  const where = target.label;
  const groupKnown = assignment !== undefined && (groups ?? []).some((g) => g.id === assignment.groupId);
  const off = locked || groups === null;
  const patch = (change: Partial<ReviewUnitAssignment>) => {
    if (assignment) onAssign({ ...assignment, ...change });
  };

  return (
    <li className="space-y-3 rounded-lg border border-sidebar-border p-3" data-unit-id={unit.id}>
      <div className="flex items-center gap-2">
        <Input
          aria-label={t(M['review_unit.name'], { target: where })}
          className={FIELD}
          value={name}
          maxLength={MAX_UNIT_NAME}
          onChange={(e) => {
            setName(e.target.value);
            if (e.target.value.trim() !== '') renameUnit(unit.id, e.target.value);
          }}
          onBlur={() => setName(stored)}
        />
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t(M['review_unit.delete'], { target: where })} onClick={() => removeUnit(unit.id)}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <p className="text-[12px] text-muted-foreground">{where}</p>
      {problems.map((p) => (
        <Alert key={p.code} variant="warning" icon>
          <AlertDescription>{p.message}</AlertDescription>
        </Alert>
      ))}
      {target.gone ? null : (
        <div className="space-y-1">
          <p className="text-[12px] text-muted-foreground">{blocks.length === 0 ? t(M['review_unit.covers_none']) : t(M['review_unit.covers'], { count: blocks.length })}</p>
          {blocks.length > 0 ? (
            <ul aria-label={t(M['review_unit.blocks'], { target: where })} className="max-h-28 space-y-0.5 overflow-y-auto rounded-md bg-sidebar-accent/30 px-2 py-1.5 text-[12px] text-sidebar-foreground/80">
              {blocks.map((b) => (
                <li key={b.id} data-block-id={b.id} className="truncate">
                  {b.label}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
      <div className="space-y-1.5">
        <NiceSelect
          // Radix keeps showing the last choice when the value goes back to none, so going back to no group starts the select afresh.
          key={assignment ? 'assigned' : 'none'}
          size="sm"
          aria-label={t(M['review_unit.group'], { target: where })}
          placeholder={t(M['review_unit.group_placeholder'])}
          value={groupKnown ? (assignment?.groupId ?? '') : ''}
          disabled={off}
          onChange={(groupId) => (assignment ? patch({ groupId: groupId as ReviewGroupId }) : onAssign(newAssignment(unit.id, groupId)))}
          options={(groups ?? []).map((g) => ({ value: g.id, label: g.name }))}
        />
        {assignmentProblem ? (
          <p className="text-[12px] text-destructive" role="alert">
            {assignmentProblem}
          </p>
        ) : null}
        {assignment === undefined && !off ? <p className="text-[12px] text-muted-foreground">{t(M['review_unit.not_assigned'])}</p> : null}
      </div>
      {assignment ? (
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_auto] items-end gap-3">
            <div className="space-y-1.5">
              <Label className="text-sidebar-foreground/80">{t(M['review_unit.visibility'])}</Label>
              <NiceSelect
                size="sm"
                aria-label={t(M['review_unit.visibility_for'], { target: where })}
                value={assignment.visibility}
                disabled={off}
                onChange={(visibility) => patch({ visibility: visibility as ReviewVisibility })}
                options={[
                  { value: 'own_unit', label: t(M['review_unit.visibility_own']) },
                  { value: 'whole_submission', label: t(M['review_unit.visibility_whole']) },
                ]}
              />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Label className="text-sidebar-foreground/80">{t(M['review_unit.required'])}</Label>
              <Switch checked={assignment.required} disabled={off} aria-label={t(M['review_unit.required_for'], { target: where })} onCheckedChange={(required) => patch({ required })} />
            </div>
          </div>
          <OrderField label={t(M['review_unit.order_for'], { target: where })} value={assignment.order} disabled={off} onChange={(order) => patch({ order })} />
          <Button type="button" size="sm" variant="ghost" disabled={off} aria-label={t(M['review_unit.unassign'], { target: where })} onClick={() => onAssign(null)}>
            {t(M['review_unit.unassign_button'])}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

/** The order is typed as text and sent only when it is a whole number of 1 or more; what was typed stays until the field is left. */
function OrderField({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (order: number) => void }) {
  const [text, setText] = useDraft(String(value));
  const valid = /^\d{1,6}$/.test(text) && Number(text) >= 1;
  return (
    <div className="space-y-1.5">
      <Label className="text-sidebar-foreground/80">{t(M['review_unit.order'])}</Label>
      <Input
        type="number"
        inputMode="numeric"
        min={1}
        step={1}
        aria-label={label}
        className={FIELD}
        value={text}
        disabled={disabled}
        aria-invalid={!valid}
        onChange={(e) => {
          setText(e.target.value);
          if (/^\d{1,6}$/.test(e.target.value) && Number(e.target.value) >= 1) onChange(Number(e.target.value));
        }}
        onBlur={() => setText(String(value))}
      />
      {valid ? (
        <p className="text-[12px] text-muted-foreground">{t(M['review_unit.order_hint'])}</p>
      ) : (
        <p className="text-[12px] text-destructive" role="alert">
          {t(M['review_unit.order_invalid'])}
        </p>
      )}
    </div>
  );
}
