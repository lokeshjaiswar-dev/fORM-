import { useEffect, useMemo } from 'react';
import { FormProvider, useForm, type FieldValues } from 'react-hook-form';
import { isAvailable } from '@form/registry';
import type { AnswerValueMap, Answers, BlockId, GroupRowId, StoredBlock } from '@form/schema';
import { RendererContext, useRenderer } from '../context.ts';
import { Block } from '../fields/Field.tsx';
import { MESSAGES } from '../messages.ts';
import { useAnswer, type ControlProps } from './hooks.ts';

type GroupValue = AnswerValueMap['repeating_group'];

function emptyRow(index: number): GroupValue['rows'][number] {
  return { rowId: `row_${index + 1}` as GroupRowId, values: {} };
}

function seedRows(count: number): GroupValue {
  return { rows: Array.from({ length: count }, (_, i) => emptyRow(i)) };
}

function RowFields({
  rowId,
  fields,
  values,
  onChange,
  onBlur,
}: {
  rowId: string;
  fields: StoredBlock[];
  values: Answers;
  onChange: (values: Answers) => void;
  onBlur: () => void;
}) {
  const parent = useRenderer();
  const methods = useForm({ defaultValues: values as FieldValues });
  const ctx = useMemo(
    () => ({ ...parent, idFor: (blockId: string) => `${parent.idFor(blockId)}-${rowId}` }),
    [parent, rowId],
  );

  useEffect(() => {
    const sub = methods.watch((data) => {
      const next: Answers = {};
      for (const [id, answer] of Object.entries(data)) {
        if (answer && typeof answer === 'object' && 'type' in answer) next[id as BlockId] = answer as Answers[BlockId];
      }
      onChange(next);
    });
    return () => sub.unsubscribe();
  }, [methods, onChange]);

  return (
    <RendererContext.Provider value={ctx}>
      <FormProvider {...methods}>
        <div className="fr-repeat-fields" onBlur={onBlur}>
          {fields.map((child) => <Block key={child.id} block={child} />)}
        </div>
      </FormProvider>
    </RendererContext.Provider>
  );
}

/** FLD-25: respondent can add and remove rows of the group's child fields. */
export function RepeatingGroup({ block, field }: ControlProps<'repeating_group'>) {
  const { def, t } = useRenderer();
  const answer = useAnswer(block);
  const c = block.config;
  const locked = field.disabled || field.readOnly;
  const childBlocks = c.children.map((id) => def.blocks[id]).filter((b): b is StoredBlock => !!b && b.type !== 'unsupported' && isAvailable(b.type));
  const rows = answer.value?.rows ?? [];
  const min = c.minRows;
  const max = c.maxRows;
  const initial = c.initialRows ?? Math.max(min, 1);

  useEffect(() => {
    if (answer.value === undefined && initial > 0) answer.set(seedRows(initial));
  }, [answer.value, answer.set, initial]);

  const write = (next: GroupValue['rows']) => {
    answer.set(next.length === 0 ? undefined : { rows: next });
  };

  const add = () => {
    if (locked || rows.length >= max) return;
    write([...rows, emptyRow(rows.length)]);
  };

  const remove = (index: number) => {
    if (locked || rows.length <= min) return;
    write(rows.filter((_, i) => i !== index));
  };

  const setRow = (index: number, values: Answers) => {
    const next = rows.map((row, i) => (i === index ? { ...row, values } : row));
    write(next);
  };

  const addLabel = c.addLabel?.trim() || t(MESSAGES['repeat.add']);
  const removeLabel = c.removeLabel?.trim() || t(MESSAGES['repeat.remove']);

  return (
    <div className="fr-repeat">
      <div className="fr-repeat-body">
        {rows.map((row, index) => (
          <div key={row.rowId} className="fr-repeat-row">
            <RowFields
              rowId={row.rowId}
              fields={childBlocks}
              values={row.values as Answers}
              onChange={(values) => setRow(index, values)}
              onBlur={answer.onBlur}
            />
            {!locked && rows.length > min ? (
              <button type="button" className="fr-repeat-remove" aria-label={removeLabel} onClick={() => remove(index)}>
                {removeLabel}
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {!locked && rows.length < max ? (
        <button type="button" className="fr-repeat-add" onClick={add} id={rows.length === 0 ? field.ids.input : undefined}>
          {addLabel}
        </button>
      ) : null}
    </div>
  );
}
