import { Plus, Trash2 } from 'lucide-react';
import { defineMessages } from '@form/i18n';
import { Button, Input, Switch } from '@dmacq/ui';
import { t } from '@/i18n';
import type { WindowRow } from '@/components/builder/access/accessModel';

const M = defineMessages('builder', {
  'access.hours_label': 'Only open at certain hours',
  'access.hours_zone': 'Hours are in {zone}.',
  'access.hours_from': 'From',
  'access.hours_to': 'To',
  'access.hours_add': 'Add hours',
  'access.hours_remove': 'Remove these hours',
  'access.day_0': 'Sun',
  'access.day_1': 'Mon',
  'access.day_2': 'Tue',
  'access.day_3': 'Wed',
  'access.day_4': 'Thu',
  'access.day_5': 'Fri',
  'access.day_6': 'Sat',
});

const DAYS = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_LABELS = [M['access.day_0'], M['access.day_1'], M['access.day_2'], M['access.day_3'], M['access.day_4'], M['access.day_5'], M['access.day_6']] as const;

/** Monday to Friday, nine to five: what turning the hours on starts from. */
const WEEKDAY_HOURS: WindowRow = { weekdays: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' };

/** The weekly opening hours (ACC-06): off means open at all hours; each row is some weekdays and a daily span in the form's zone. */
export function WeeklyHours({
  windows,
  zone,
  onChange,
  field,
  labelCls,
  error,
}: {
  windows: WindowRow[];
  zone: string;
  onChange: (windows: WindowRow[]) => void;
  field: string | undefined;
  labelCls: string | undefined;
  error: string | undefined;
}) {
  const patch = (index: number, change: Partial<WindowRow>) => onChange(windows.map((w, i) => (i === index ? { ...w, ...change } : w)));
  const toggleDay = (index: number, day: number) => {
    const row = windows[index];
    if (!row) return;
    patch(index, { weekdays: row.weekdays.includes(day) ? row.weekdays.filter((d) => d !== day) : [...row.weekdays, day] });
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span id="access-hours-label" className={labelCls ?? 'text-sm font-medium'}>{t(M['access.hours_label'])}</span>
        <Switch aria-labelledby="access-hours-label" checked={windows.length > 0} onCheckedChange={(on) => onChange(on ? [{ ...WEEKDAY_HOURS }] : [])} />
      </div>
      {windows.length > 0 ? (
        <>
          <p className="text-[12px] text-muted-foreground">{t(M['access.hours_zone'], { zone })}</p>
          {windows.map((row, index) => (
            <div key={index} className="space-y-1.5 rounded-md border border-border/60 p-2">
              <div className="flex flex-wrap gap-1">
                {DAYS.map((day) => (
                  <Button key={day} type="button" size="xs" variant="outline" pressed={row.weekdays.includes(day)} onClick={() => toggleDay(index, day)}>
                    {t(DAY_LABELS[day]!)}
                  </Button>
                ))}
              </div>
              <div className="flex items-end gap-2">
                <label className="flex-1 text-[12px]">
                  <span className={labelCls}>{t(M['access.hours_from'])}</span>
                  <Input type="time" className={field} value={row.from} onChange={(e) => patch(index, { from: e.target.value })} />
                </label>
                <label className="flex-1 text-[12px]">
                  <span className={labelCls}>{t(M['access.hours_to'])}</span>
                  <Input type="time" className={field} value={row.to} onChange={(e) => patch(index, { to: e.target.value })} />
                </label>
                <Button type="button" size="icon-sm" variant="ghost" aria-label={t(M['access.hours_remove'])} onClick={() => onChange(windows.filter((_, i) => i !== index))}>
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={() => onChange([...windows, { ...WEEKDAY_HOURS }])}>
            <Plus className="size-4" /> {t(M['access.hours_add'])}
          </Button>
        </>
      ) : null}
      {error ? <p className="text-[12px] text-destructive" role="alert">{error}</p> : null}
    </div>
  );
}
