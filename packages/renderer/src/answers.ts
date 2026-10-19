import type { AnswerValue, Answers, FieldBlock, IsoDate, IsoInstant, IsoTime, PublicFormDefinition } from '@form/schema';
import type { RawAnswers } from '@form/validation/lazy';
import { templateText, type PipeContext } from './text.ts';

/** HH:MM of `now` in `timeZone`; UTC when the zone is unknown. */
function timeIn(now: IsoInstant, timeZone: string): IsoTime {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const time = `${get('hour')}:${get('minute')}`;
    if (/^\d{2}:\d{2}$/.test(time)) return time as IsoTime;
  } catch {
    /* An unknown zone falls through to UTC. */
  }
  return now.slice(11, 16) as IsoTime;
}

/** The configured default answer of a field, or undefined (computed with the session clock and URL parameters). */
function defaultOf(block: FieldBlock, today: IsoDate, ctx: PipeContext & { now: IsoInstant }): AnswerValue | undefined {
  switch (block.type) {
    case 'short_text':
    case 'long_text':
    case 'url': {
      const d = block.config.defaultValue;
      const value = d === undefined ? '' : d.kind === 'static' ? d.value : templateText(d.value, ctx);
      return value ? ({ type: block.type, value } as AnswerValue) : undefined;
    }
    case 'email': {
      const d = block.config.defaultValue;
      const address = d === undefined ? '' : d.kind === 'static' ? d.value : templateText(d.value, ctx);
      return address ? { type: 'email', value: { address: address as never } } : undefined;
    }
    case 'number':
      return block.config.defaultValue === undefined ? undefined : { type: 'number', value: block.config.defaultValue };
    case 'single_choice':
      return block.config.defaultOptionId === undefined ? undefined : { type: 'single_choice', value: { optionId: block.config.defaultOptionId } };
    case 'multi_choice':
      return block.config.defaultOptionIds?.length ? { type: 'multi_choice', value: { optionIds: [...block.config.defaultOptionIds] } } : undefined;
    case 'date': {
      const d = block.config.defaultValue;
      return d === undefined ? undefined : { type: 'date', value: d.kind === 'today' ? today : d.date };
    }
    case 'time': {
      const d = block.config.defaultValue;
      return d === undefined ? undefined : { type: 'time', value: { start: d.kind === 'now' ? timeIn(ctx.now, ctx.meta.timeZone) : d.time } };
    }
    case 'rating':
      return block.config.defaultValue === undefined ? undefined : { type: 'rating', value: block.config.defaultValue };
    default:
      return undefined;
  }
}

/** The answers a session starts from: the host's (resume, prefill) over each field's default. */
export function startingAnswers(def: PublicFormDefinition, initial: Answers | undefined, today: IsoDate, ctx: PipeContext & { now: IsoInstant }): RawAnswers {
  const out: Record<string, AnswerValue | null> = {};
  for (const block of Object.values(def.blocks)) {
    if (!block || block.type === 'unsupported' || !('key' in block)) continue;
    const given = initial?.[block.id];
    const value = given ?? defaultOf(block, today, ctx);
    out[block.id] = value ?? null;
  }
  return out;
}
