import { Button, Input, Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@dmacq/ui';
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
    <Input
      id={id}
      size="sm"
      type={HTML_TYPE[type]}
      inputMode={type === 'number' || type === 'formula' ? 'decimal' : undefined}
      aria-label={label}
      value={value}
      disabled={disabled}
      readOnly={readOnly || onChange === undefined}
      onChange={onChange ? (e) => onChange(e.target.value) : undefined}
      onBlur={onBlur}
      className="min-w-0 w-full border-transparent bg-transparent text-center shadow-none"
    />
  );
}

export function DynamicTableFrame({ columns, rows, footer, toolbar, belowRows }: DynamicTableFrameProps) {
  const hasAction = rows.some((row) => row.action !== undefined);
  return (
    <div className="w-full overflow-hidden rounded-md border" style={{ borderColor: 'var(--fr-inputBorder)' }}>
      {toolbar ? <div className="flex flex-wrap items-center justify-end gap-2 border-b px-3 py-2" style={{ borderColor: 'var(--fr-inputBorder)' }}>{toolbar}</div> : null}
      <Table
        containerClassName="max-w-full"
        style={{ tableLayout: 'fixed', width: `max(100%, ${columns.length * 10}rem)` }}
      >
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col.key} className="whitespace-nowrap text-center">
                <span>{col.label}</span>
                {col.onRemove ? (
                  <Button type="button" variant="ghost" size="xs" aria-label={`${col.removeLabel ?? 'Remove'}: ${col.label}`} onClick={col.onRemove}>
                    ×
                  </Button>
                ) : null}
              </TableHead>
            ))}
            {hasAction ? <TableHead className="w-12 text-center" /> : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.key}>
              {row.cells.map((cell, i) => (
                <TableCell key={i} className="p-1 text-center align-middle">{cell}</TableCell>
              ))}
              {hasAction ? <TableCell className="w-12 p-1 text-center">{row.action}</TableCell> : null}
            </TableRow>
          ))}
        </TableBody>
        {footer ? (
          <TableFooter>
            <TableRow>
              {footer.map((cell, i) => (
                <TableCell key={i} className="whitespace-nowrap text-center font-medium">{cell}</TableCell>
              ))}
              {hasAction ? <TableCell className="w-12" /> : null}
            </TableRow>
          </TableFooter>
        ) : null}
      </Table>
      {belowRows ? <div className="border-t px-3 py-2" style={{ borderColor: 'var(--fr-inputBorder)' }}>{belowRows}</div> : null}
    </div>
  );
}
