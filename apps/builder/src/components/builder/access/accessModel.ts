import { canonicalJson, type RichDoc } from '@form/schema';
import { richDoc } from '@/lib/definition';
import { inputOf, type AccessInput, type AccessSettings } from '@/persistence/accessApi';
import { instantToZoned, zonedToInstant } from '@/components/builder/access/zoned';

/*
 * The Access panel's form and the settings it saves, as plain data: what the author types (dates as wall-clock text in the
 * org's zone, lists as one entry per line) on one side, `PUT .../access`'s body on the other. The server checks every
 * value again and is the authority; the checks here only let the panel say what is wrong before a round trip.
 */

export interface WindowRow {
  /** 0 is Sunday, as `availability.windows[].weekdays` counts. */
  weekdays: number[];
  /** `HH:MM`. */
  from: string;
  to: string;
}

export interface AccessForm {
  /** `!enabled`: the form is switched off (ACC-01). */
  closed: boolean;
  /** The text of the closed screen (`screens.closed`); a blank document means the renderer's own wording. */
  closedMessage: RichDoc;
  /** `datetime-local` text in the org's zone; empty for none (ACC-02, ACC-03). */
  openAt: string;
  closeAt: string;
  /** Digits; empty for no limit (ACC-04). */
  limit: string;
  /** Weekly hours (ACC-06); no rows means open at all hours. */
  windows: WindowRow[];
  windowZone: string;
  /** One https origin per line (ACC-08). */
  embed: string;
  /** One host name per line; empty for no restriction. */
  redirects: string;
  /** Digits: how long the previous version keeps taking answers after a publish. */
  previousHours: string;
}

export type FormProblem = 'date_invalid' | 'close_before_open' | 'limit_invalid' | 'window_invalid' | 'embed_invalid' | 'redirect_invalid' | 'hours_invalid';
export type FieldName = 'openAt' | 'closeAt' | 'limit' | 'windows' | 'embed' | 'redirects' | 'previousHours';
export type Built = { ok: true; input: AccessInput } | { ok: false; problems: Partial<Record<FieldName, FormProblem>> };

/** The most responses a limit may name: far beyond a form's use, and inside what the API takes. */
export const MAX_LIMIT = 1_000_000_000;
export const MAX_PREVIOUS_HOURS = 720;

/** A document with nothing in it: no node but empty paragraphs. */
export function isBlankDoc(doc: RichDoc | undefined): boolean {
  return doc === undefined || doc.content.every((node) => node.type === 'paragraph' && (node.content?.length ?? 0) === 0);
}

/** The author's closed screen in a settings' `screens`, when it has one. */
function closedScreen(screens: Record<string, unknown>): { content: RichDoc } & Record<string, unknown> | undefined {
  const screen = screens['closed'];
  if (typeof screen !== 'object' || screen === null) return undefined;
  const content = (screen as { content?: unknown }).content;
  return typeof content === 'object' && content !== null && (content as { type?: unknown }).type === 'doc' ? (screen as { content: RichDoc } & Record<string, unknown>) : undefined;
}

/** The text of the closed screen the server holds, or an empty document. */
export const closedMessageOf = (settings: Pick<AccessSettings, 'screens'>): RichDoc => closedScreen(settings.screens)?.content ?? richDoc('');

/** The form for settings read from the server; `zone` is the org's time zone, in which the dates are shown. */
export function formOf(settings: AccessSettings, zone: string): AccessForm {
  return {
    closed: !settings.enabled,
    closedMessage: closedMessageOf(settings),
    openAt: settings.openAt ? instantToZoned(settings.openAt, zone) : '',
    closeAt: settings.closeAt ? instantToZoned(settings.closeAt, zone) : '',
    limit: settings.submissionLimit === undefined ? '' : String(settings.submissionLimit),
    windows: (settings.availability?.windows ?? []).map((w) => ({ weekdays: [...w.weekdays], from: w.from, to: w.to })),
    windowZone: settings.availability?.timeZone ?? zone,
    embed: settings.embedAllowlist.join('\n'),
    redirects: (settings.redirectAllowlist ?? []).join('\n'),
    previousHours: String(settings.acceptPreviousVersionsHours),
  };
}

/** The entries of a list typed one per line (commas and spaces also separate): trimmed, lower-cased, each once. */
export function entriesOf(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
}

const ORIGIN = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;
const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A date typed as wall-clock text becomes an instant; text that is the stored instant's own reading keeps the stored value, so seconds a save did not show are not lost. */
function instantOf(text: string, stored: string | undefined, zone: string): string | null {
  if (stored !== undefined && text === instantToZoned(stored, zone)) return stored;
  return zonedToInstant(text, zone);
}

/**
 * The body of a save for `form`, on top of what the server holds (`loaded`: its other screens and the settings the panel
 * does not show stay as they are). `zone` is the org's time zone, which the dates were typed in. Problems are named
 * by field, so the panel can put each next to its input.
 */
export function inputFromForm(form: AccessForm, loaded: AccessSettings, zone: string): Built {
  const problems: Partial<Record<FieldName, FormProblem>> = {};

  const openAt = form.openAt === '' ? undefined : instantOf(form.openAt, loaded.openAt, zone);
  if (openAt === null) problems.openAt = 'date_invalid';
  const closeAt = form.closeAt === '' ? undefined : instantOf(form.closeAt, loaded.closeAt, zone);
  if (closeAt === null) problems.closeAt = 'date_invalid';
  if (typeof openAt === 'string' && typeof closeAt === 'string' && !(Date.parse(closeAt) > Date.parse(openAt))) problems.closeAt = 'close_before_open';

  let submissionLimit: number | undefined;
  const limit = form.limit.trim();
  if (limit !== '') {
    submissionLimit = /^\d{1,10}$/.test(limit) ? Number(limit) : NaN;
    if (!(submissionLimit >= 1 && submissionLimit <= MAX_LIMIT)) problems.limit = 'limit_invalid';
  }

  const hours = form.previousHours.trim();
  const acceptPreviousVersionsHours = /^\d{1,4}$/.test(hours) ? Number(hours) : NaN;
  if (!(acceptPreviousVersionsHours >= 0 && acceptPreviousVersionsHours <= MAX_PREVIOUS_HOURS)) problems.previousHours = 'hours_invalid';

  const windows = form.windows.map((w) => ({ weekdays: [...new Set(w.weekdays)].sort((a, b) => a - b), from: w.from, to: w.to }));
  if (windows.some((w) => w.weekdays.length === 0 || !CLOCK.test(w.from) || !CLOCK.test(w.to) || w.from === w.to)) problems.windows = 'window_invalid';

  const embedAllowlist = entriesOf(form.embed);
  if (!embedAllowlist.every((o) => ORIGIN.test(o))) problems.embed = 'embed_invalid';
  const redirectAllowlist = entriesOf(form.redirects);
  if (!redirectAllowlist.every((h) => HOST.test(h))) problems.redirects = 'redirect_invalid';

  if (Object.keys(problems).length > 0) return { ok: false, problems };

  // Every role's screen the server holds stays; only the closed one is the author's text here.
  const otherScreens = Object.fromEntries(Object.entries(loaded.screens).filter(([role]) => role !== 'closed'));
  const keptClosed = closedScreen(loaded.screens);
  const screens: Record<string, unknown> = isBlankDoc(form.closedMessage) ? otherScreens : { ...otherScreens, closed: { ...(keptClosed ?? {}), content: form.closedMessage } };

  return {
    ok: true,
    input: {
      enabled: !form.closed,
      ...(openAt !== undefined && openAt !== null ? { openAt } : {}),
      ...(closeAt !== undefined && closeAt !== null ? { closeAt } : {}),
      ...(windows.length > 0 ? { availability: { timeZone: form.windowZone, windows } } : {}),
      ...(submissionLimit !== undefined ? { submissionLimit } : {}),
      embedAllowlist,
      ...(redirectAllowlist.length > 0 ? { redirectAllowlist } : {}),
      screens,
      acceptPreviousVersionsHours,
    },
  };
}

/** Whether saving `form` would change what the server holds: a form that does not need saving leaves the Save button off. */
export function isChanged(form: AccessForm, loaded: AccessSettings, zone: string): boolean {
  const built = inputFromForm(form, loaded, zone);
  // A form with problems is not "unchanged": the author is mid-edit and Save should say what is wrong.
  return !built.ok || canonicalJson(built.input) !== canonicalJson(inputOf(loaded));
}
