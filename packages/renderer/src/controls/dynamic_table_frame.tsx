import type { ReactNode } from 'react';
import type { DynamicColumnInput } from '@form/schema';

/*
 * The one table layout of a dynamic table, shared by the respondent's control and the builder canvas, so edit and
 * preview look the same. Presentation only: the control supplies values and handlers.
 */

export interface FrameColumn {
  key: string;
  label: string;
  /** A respondent-added column can be removed from its header. */
  onRemove?: (() => void) | undefined;
  removeLabel?: string | undefined;
}

export interface FrameRow {
  key: string;
  cells: ReactNode[];
  /** Row action (remove), in a trailing narrow column. */
  action?: ReactNode;
}

export interface DynamicTableFrameProps {
  columns: FrameColumn[];
  rows: FrameRow[];
  /** One footer cell per column; omitted when no column has a summary. */
  footer?: ReactNode[] | null;
  /** Right-aligned bar above the table (the add column action). */
  toolbar?: ReactNode;
  /** Below the table (the add row action). */
  belowRows?: ReactNode;
}

const HTML_TYPE: Record<DynamicColumnInput, string> = {
  text: 'text',
  long_text: 'text',
  number: 'text',
  date: 'date',
  datetime: 'datetime-local',
  time: 'time',
  email: 'email',
  url: 'url',
  phone: 'tel',
  formula: 'text',
};



/** One cell: a borderless input so the table grid carries the structure, the same in edit and preview. */
export function DynamicCellInput({
  type, label, value, onChange, onBlur, id, disabled, readOnly,
}: {
  type: DynamicColumnInput;
  label: string;
  value: string;
  onChange?: ((value: string) => void) | undefined;
  onBlur?: (() => void) | undefined;
  id?: string | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
}) {
  return (
    <input
      id={id}
      className="fr-input fr-dtable-cell"
      type={HTML_TYPE[type]}
      inputMode={type === 'number' || type === 'formula' ? 'decimal' : undefined}
      aria-label={label}
      value={value}
      disabled={disabled}
      readOnly={readOnly || onChange === undefined}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      onBlur={onBlur}
    />
  );
}

export function DynamicTableFrame({ columns, rows, footer, toolbar, belowRows }: DynamicTableFrameProps) {
  const hasAction = rows.some((row) => row.action !== undefined);
  return (
    <div className="fr-dtable">
      {toolbar ? <div className="fr-dtable-toolbar">{toolbar}</div> : null}
      <div className="fr-dtable-scroll">
        <table className="fr-dtable-table" style={{ width: `max(100%, ${columns.length * 10}rem)` }}>
          <thead>
            <tr>
              {columns.map((col) => (
                <th key={col.key} scope="col">
                  <span>{col.label}</span>
                  {col.onRemove ? (
                    <button type="button" className="fr-link-button fr-dtable-remove-col" aria-label={`${col.removeLabel ?? 'Remove'}: ${col.label}`} onClick={col.onRemove}>
                      ×
                    </button>
                  ) : null}
                </th>
              ))}
              {hasAction ? <th className="fr-dtable-action" /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                {row.cells.map((cell, i) => (
                  <td key={i}>{cell}</td>
                ))}
                {hasAction ? <td className="fr-dtable-action">{row.action}</td> : null}
              </tr>
            ))}
          </tbody>
          {footer ? (
            <tfoot>
              <tr>
                {footer.map((cell, i) => (
                  <td key={i}>{cell}</td>
                ))}
                {hasAction ? <td className="fr-dtable-action" /> : null}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      {belowRows ? <div className="fr-dtable-below">{belowRows}</div> : null}
    </div>
  );
}
