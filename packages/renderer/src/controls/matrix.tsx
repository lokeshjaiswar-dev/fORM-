import type { MatrixColumnId, MatrixRowId, MatrixValue } from '@form/schema';
import { useAnswer, usePipes, type ControlProps } from './hooks.ts';

/**
 * FLD-24: a table of rows × columns. Single mode is one radio per row; multi is checkboxes; grid is a text cell.
 */
export function Matrix({ block, field }: ControlProps<'matrix'>) {
  const { text } = usePipes();
  const answer = useAnswer(block);
  const c = block.config;
  const locked = field.disabled || field.readOnly;
  const value = answer.value;
  const mode = c.mode;

  const write = (next: MatrixValue) => {
    const empty = Object.keys(next.rows).length === 0;
    answer.set(empty ? undefined : next);
  };

  const setSingle = (rowId: MatrixRowId, colId: MatrixColumnId) => {
    const rows = { ...(value?.mode === 'single' ? value.rows : {}) };
    if (rows[rowId] === colId) delete rows[rowId];
    else rows[rowId] = colId;
    write({ mode: 'single', rows });
  };

  const setMulti = (rowId: MatrixRowId, colId: MatrixColumnId, on: boolean) => {
    const rows = { ...(value?.mode === 'multi' ? value.rows : {}) };
    const current = [...(rows[rowId] ?? [])];
    const next = on ? [...current.filter((id) => id !== colId), colId] : current.filter((id) => id !== colId);
    if (next.length === 0) delete rows[rowId];
    else rows[rowId] = next;
    write({ mode: 'multi', rows });
  };

  const setGrid = (rowId: MatrixRowId, colId: MatrixColumnId, cell: string) => {
    const rows = { ...(value?.mode === 'grid' ? value.rows : {}) };
    const current = { ...(rows[rowId] ?? {}) };
    if (cell === '') delete current[colId];
    else current[colId] = cell;
    if (Object.keys(current).length === 0) delete rows[rowId];
    else rows[rowId] = current;
    write({ mode: 'grid', rows });
  };

  return (
    <div className="fr-matrix-wrap">
      <table className="fr-matrix">
        <thead>
          <tr>
            <th />
            {c.columns.map((col) => (
              <th key={col.id}>{col.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {c.rows.map((row, ri) => (
            <tr key={row.id}>
              <th scope="row">{typeof row.label === 'string' ? row.label : text(row.label)}</th>
              {c.columns.map((col, ci) => {
                const inputId = ri === 0 && ci === 0 ? field.ids.input : undefined;
                if (mode === 'single') {
                  const checked = value?.mode === 'single' && value.rows[row.id] === col.id;
                  return (
                    <td key={col.id}>
                      <input
                        id={inputId}
                        type="radio"
                        name={`${field.ids.base}-${row.id}`}
                        checked={checked}
                        disabled={locked}
                        onChange={() => setSingle(row.id, col.id)}
                        onBlur={answer.onBlur}
                      />
                    </td>
                  );
                }
                if (mode === 'multi') {
                  const checked = value?.mode === 'multi' && (value.rows[row.id] ?? []).includes(col.id);
                  return (
                    <td key={col.id}>
                      <input
                        id={inputId}
                        type="checkbox"
                        checked={checked}
                        disabled={locked}
                        onChange={(e) => setMulti(row.id, col.id, e.target.checked)}
                        onBlur={answer.onBlur}
                      />
                    </td>
                  );
                }
                const cell = value?.mode === 'grid' ? String(value.rows[row.id]?.[col.id] ?? '') : '';
                return (
                  <td key={col.id}>
                    <input
                      id={inputId}
                      className="fr-input"
                      type={col.input === 'number' ? 'text' : 'text'}
                      inputMode={col.input === 'number' ? 'decimal' : undefined}
                      value={cell}
                      disabled={field.disabled}
                      readOnly={field.readOnly || undefined}
                      onChange={(e) => setGrid(row.id, col.id, e.target.value)}
                      onBlur={answer.onBlur}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
