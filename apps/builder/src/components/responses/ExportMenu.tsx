import { useEffect, useId, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Textarea } from '@dmacq/ui';
import { defineMessages, type MessageId } from '@form/i18n';
import { t } from '@/i18n';
import { ApiProblem, ApiUnreachable, useActiveOrg } from '@/auth/client';
import { describeFailure } from '@/components/responses/errors';
import { dayEnd, dayStart } from '@/components/responses/filters';
import {
  EXPORT_FORMATS,
  ExportExpired,
  ExportFailed,
  ExportTimedOut,
  MAX_SELECTED,
  canExport,
  newIdempotencyKey,
  runExport,
  saveFile,
  type ExportFormat,
  type ExportRequest,
  type ExportScope,
  type ExportState,
} from '@/persistence/exportsApi';

const M = defineMessages('builder', {
  'responses.export.button': 'Export',
  'responses.export.title': 'Export responses',
  'responses.export.description': 'The file is built in the background and downloads here when it is ready. It is kept on the server for 24 hours.',
  'responses.export.format': 'File type',
  'responses.export.format_csv': 'CSV (opens in any spreadsheet)',
  'responses.export.format_xlsx': 'Excel (.xlsx)',
  'responses.export.scope': 'Responses to include',
  'responses.export.scope_all': 'All responses',
  'responses.export.scope_selected': '{n, plural, =0 {Selected responses (none selected)} one {# selected response} other {# selected responses}}',
  'responses.export.scope_range': 'Received between',
  'responses.export.from': 'From',
  'responses.export.to': 'To',
  'responses.export.range_needed': 'Pick a start date, an end date, or both.',
  'responses.export.range_backwards': 'The start date is after the end date.',
  'responses.export.sensitive': 'Include sensitive and encrypted fields',
  'responses.export.sensitive_hint': 'They are masked in the file unless you include them. Including them is recorded with your reason.',
  'responses.export.reason': 'Why do you need them?',
  'responses.export.reason_hint': 'Kept on the audit record of this export.',
  'responses.export.start': 'Start export',
  'responses.export.close': 'Close',
  'responses.export.starting': 'Starting the export…',
  'responses.export.queued': 'Waiting for the export to start…',
  'responses.export.running': 'Building your file…',
  'responses.export.downloading': 'Downloading…',
  'responses.export.done': 'Downloaded {name}.',
  'responses.export.failed': 'The export could not be built. Start it again.',
  'responses.export.failed_reason': 'The export could not be built: {reason} Start it again.',
  'responses.export.expired': 'The file was removed before it was downloaded. Start a new export.',
  'responses.export.timed_out': 'The export is taking longer than expected. It keeps building: start it again in a few minutes to pick it up.',
  'responses.export.try_later': 'Too many exports are being built, or too many were asked for today. Try again later.',
  'responses.export.reason_missing': 'Say why the export includes sensitive fields.',
  'responses.export.generic': 'The export could not be started. Try again.',
});

const FORMAT_LABELS: Record<ExportFormat, MessageId> = {
  csv: M['responses.export.format_csv'],
  xlsx: M['responses.export.format_xlsx'],
};

type ScopeKind = ExportScope['kind'];

interface Options {
  format: ExportFormat;
  scope: ScopeKind;
  /** `YYYY-MM-DD` of a date input, in the member's own time zone, like the filters above the grid. */
  from: string;
  to: string;
  includeSensitive: boolean;
  reason: string;
}

type Run =
  | { phase: 'idle' }
  | { phase: 'working'; text: string }
  | { phase: 'done'; name: string }
  | { phase: 'failed'; text: string };

/** What the export asks the API for, or why it cannot be asked yet. */
function requestOf(o: Options, selectedIds: readonly string[]): { request: ExportRequest } | { problem: MessageId | null } {
  if (o.includeSensitive && o.reason.trim() === '') return { problem: null };
  let scope: ExportScope;
  if (o.scope === 'selected') {
    if (selectedIds.length === 0) return { problem: null };
    scope = { kind: 'selected', ids: selectedIds.slice(0, MAX_SELECTED) };
  } else if (o.scope === 'filtered') {
    const from = dayStart(o.from);
    const to = dayEnd(o.to);
    if (from === undefined && to === undefined) return { problem: M['responses.export.range_needed'] };
    if (from !== undefined && to !== undefined && Date.parse(from) > Date.parse(to)) return { problem: M['responses.export.range_backwards'] };
    scope = { kind: 'filtered', ...(from ? { from } : {}), ...(to ? { to } : {}) };
  } else {
    scope = { kind: 'all' };
  }
  return { request: { format: o.format, scope, ...(o.includeSensitive ? { includeSensitive: true, reason: o.reason.trim() } : {}) } };
}

/** The member-facing sentence for an export that did not finish. */
function failureText(err: unknown): string {
  if (err instanceof ExportFailed) return err.reason ? t(M['responses.export.failed_reason'], { reason: err.reason.replace(/\s+$/, '') }) : t(M['responses.export.failed']);
  if (err instanceof ExportExpired) return t(M['responses.export.expired']);
  if (err instanceof ExportTimedOut) return t(M['responses.export.timed_out']);
  if (err instanceof ApiProblem && err.status === 429) return t(M['responses.export.try_later']);
  if (err instanceof ApiProblem && err.code === 'EXPORT_REASON_REQUIRED') return t(M['responses.export.reason_missing']);
  return describeFailure(err, M['responses.export.generic']);
}

/**
 * Whether a finished action's key is spent. A request that got no answer (the API unreachable, a proxy's 5xx) may have
 * been stored, so the next Start is the same action and sends the same key; the API then returns the export it made. Every
 * other outcome is final (done, failed, expired, a refusal), so the next Start is a new action with a new key.
 */
const keyIsKept = (err: unknown): boolean =>
  err instanceof ExportTimedOut || err instanceof ApiUnreachable || (err instanceof ApiProblem && [502, 503, 504].includes(err.status));

interface DialogProps {
  formId: string;
  org: string;
  selectedIds: readonly string[];
  from: string;
  to: string;
  onClose: () => void;
}

/** The options and the run. Mounted when the dialog opens, so every opening starts from the grid's current selection and dates. */
function ExportForm({ formId, org, selectedIds, from, to, onClose }: DialogProps) {
  const ids = useId();
  const [options, setOptions] = useState<Options>({
    format: 'csv',
    scope: selectedIds.length > 0 ? 'selected' : from || to ? 'filtered' : 'all',
    from,
    to,
    includeSensitive: false,
    reason: '',
  });
  const [run, setRun] = useState<Run>({ phase: 'idle' });
  /** The member action in progress or last tried: its key and the request it was made for (a changed request is a new action). */
  const action = useRef<{ key: string; request: string } | null>(null);
  const abort = useRef<AbortController | null>(null);

  // Closing the dialog, or leaving the page, stops waiting for the file. The export itself carries on.
  useEffect(() => () => abort.current?.abort(), []);

  const set = (change: Partial<Options>) => setOptions((current) => ({ ...current, ...change }));
  const built = requestOf(options, selectedIds);
  const working = run.phase === 'working';
  const problem = 'problem' in built ? built.problem : null;

  async function start() {
    if (!('request' in built) || working) return;
    const { request } = built;
    const signature = JSON.stringify(request);
    if (action.current?.request !== signature) action.current = { key: newIdempotencyKey(), request: signature };
    const { key } = action.current;
    const controller = new AbortController();
    abort.current = controller;
    setRun({ phase: 'working', text: t(M['responses.export.starting']) });
    try {
      const file = await runExport({
        org,
        formId,
        request,
        key,
        signal: controller.signal,
        onState: (state: ExportState) => setRun({ phase: 'working', text: t(state.status === 'queued' ? M['responses.export.queued'] : M['responses.export.running']) }),
        onDownloading: () => setRun({ phase: 'working', text: t(M['responses.export.downloading']) }),
      });
      saveFile(file);
      action.current = null;
      setRun({ phase: 'done', name: file.name });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (!keyIsKept(err)) action.current = null;
      setRun({ phase: 'failed', text: failureText(err) });
    }
  }

  const legend = 'mb-1.5 text-[13px] font-medium text-foreground';
  const choice = 'flex items-center gap-2 text-[14px]';
  const control = 'h-8 rounded-[8px] border border-border-control bg-background px-2 text-[13px] text-foreground';

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t(M['responses.export.title'])}</DialogTitle>
        <DialogDescription>{t(M['responses.export.description'])}</DialogDescription>
      </DialogHeader>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void start();
        }}
      >
        <fieldset disabled={working} className="flex flex-col gap-4">
          <div role="radiogroup" aria-labelledby={`${ids}-format`}>
            <p id={`${ids}-format`} className={legend}>
              {t(M['responses.export.format'])}
            </p>
            <div className="flex flex-col gap-1.5">
              {EXPORT_FORMATS.map((format) => (
                <label key={format} className={choice}>
                  <input type="radio" name={`${ids}-format`} className="size-4" checked={options.format === format} onChange={() => set({ format })} />
                  {t(FORMAT_LABELS[format])}
                </label>
              ))}
            </div>
          </div>

          <div role="radiogroup" aria-labelledby={`${ids}-scope`}>
            <p id={`${ids}-scope`} className={legend}>
              {t(M['responses.export.scope'])}
            </p>
            <div className="flex flex-col gap-1.5">
              <label className={choice}>
                <input type="radio" name={`${ids}-scope`} className="size-4" checked={options.scope === 'all'} onChange={() => set({ scope: 'all' })} />
                {t(M['responses.export.scope_all'])}
              </label>
              <label className={choice}>
                <input
                  type="radio"
                  name={`${ids}-scope`}
                  className="size-4"
                  checked={options.scope === 'selected'}
                  disabled={selectedIds.length === 0}
                  onChange={() => set({ scope: 'selected' })}
                />
                {t(M['responses.export.scope_selected'], { n: selectedIds.length })}
              </label>
              <label className={choice}>
                <input type="radio" name={`${ids}-scope`} className="size-4" checked={options.scope === 'filtered'} onChange={() => set({ scope: 'filtered' })} />
                {t(M['responses.export.scope_range'])}
              </label>
              {options.scope === 'filtered' ? (
                <div className="ml-6 flex flex-wrap items-center gap-3">
                  <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                    {t(M['responses.export.from'])}
                    <input type="date" className={control} value={options.from} max={options.to || undefined} onChange={(e) => set({ from: e.target.value })} />
                  </label>
                  <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
                    {t(M['responses.export.to'])}
                    <input type="date" className={control} value={options.to} min={options.from || undefined} onChange={(e) => set({ to: e.target.value })} />
                  </label>
                </div>
              ) : null}
              {options.scope === 'filtered' && problem ? (
                <p role="alert" className="ml-6 text-[13px] text-destructive">
                  {t(problem)}
                </p>
              ) : null}
            </div>
          </div>

          <div>
            <label className={choice}>
              <input type="checkbox" className="size-4" checked={options.includeSensitive} onChange={(e) => set({ includeSensitive: e.target.checked })} />
              {t(M['responses.export.sensitive'])}
            </label>
            <p className="ml-6 mt-0.5 text-[13px] text-muted-foreground">{t(M['responses.export.sensitive_hint'])}</p>
            {options.includeSensitive ? (
              <div className="ml-6 mt-2">
                <label htmlFor={`${ids}-reason`} className="text-[13px] font-medium text-foreground">
                  {t(M['responses.export.reason'])}
                </label>
                <Textarea id={`${ids}-reason`} className="mt-1" rows={2} maxLength={1000} required value={options.reason} onChange={(e) => set({ reason: e.target.value })} />
                <p className="mt-0.5 text-[13px] text-muted-foreground">{t(M['responses.export.reason_hint'])}</p>
              </div>
            ) : null}
          </div>
        </fieldset>

        <div role="status" aria-live="polite" className={run.phase === 'failed' ? 'text-[13px] text-destructive' : 'text-[13px] text-muted-foreground'}>
          {run.phase === 'working' ? run.text : run.phase === 'done' ? t(M['responses.export.done'], { name: run.name }) : run.phase === 'failed' ? run.text : ''}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t(M['responses.export.close'])}
          </Button>
          <Button type="submit" disabled={working || !('request' in built)}>
            {t(M['responses.export.start'])}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

export interface ExportMenuProps {
  formId: string;
  /** The ids of the responses ticked in the grid (any page loaded so far). */
  selectedIds: readonly string[];
  /** The `YYYY-MM-DD` of the date filters above the grid, which the date range starts from. */
  from: string;
  to: string;
}

/**
 * The Export button of the Responses toolbar and the dialog behind it (WP-1.17): CSV or Excel, all responses, the selected
 * ones or a date range, optionally with sensitive fields (which needs a reason). It shows only when the active org grants
 * the member `submissions.export`; the API checks that again on every call. Pressing Start asks for the export, waits for
 * the worker to build it and saves the file, and a failed, expired or refused export says so in words.
 */
export function ExportMenu({ formId, selectedIds, from, to }: ExportMenuProps) {
  const org = useActiveOrg();
  const orgId = org?.id ?? null;
  const [allowed, setAllowed] = useState<{ org: string; ok: boolean } | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    let live = true;
    canExport(orgId).then(
      (ok) => live && setAllowed({ org: orgId, ok }),
      // Not knowing is not a yes: the button stays hidden, and the API would refuse the call anyway.
      () => live && setAllowed({ org: orgId, ok: false }),
    );
    return () => {
      live = false;
    };
  }, [orgId]);

  if (!orgId || allowed?.org !== orgId || !allowed.ok) return null;

  return (
    <>
      <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setOpen(true)}>
        <Download />
        {t(M['responses.export.button'])}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <ExportForm formId={formId} org={orgId} selectedIds={selectedIds} from={from} to={to} onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
