// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Evaluator } from '@form/logic';
import type { BlockId, EvalMeta, IsoDate, OptionId } from '@form/schema';
import { FormRenderer, type SubmitPayload } from '../src/index.ts';
import { EvalSession } from '../src/eval/session.ts';
import { EN_IN, STARTED_AT, field, form, id, options, page, props, rule, runtime, show, when } from './build.ts';

/* The session clock (`meta.now` frozen at session start, schema §19) and incremental evaluation from `reads`. */

const META: EvalMeta = { now: STARTED_AT, timeZone: id('Asia/Kolkata'), locale: EN_IN, urlParams: {}, isPreview: false, shuffleSeed: 's' };

afterEach(() => {
  vi.useRealTimers();
});

describe('EvalSession', () => {
  function session() {
    const yesNo = field('single_choice', 'attending', { config: { display: 'radio', options: [{ id: id<OptionId>('yes'), label: 'Yes' }, { id: id<OptionId>('no'), label: 'No' }] } });
    const def = form([yesNo, field('short_text', 'reason', { initiallyHidden: true }), field('short_text', 'name')], [page('p1', ['attending', 'reason', 'name'])], [
      rule('r1', when('attending', 'eq', options('attending', 'yes')), [show('reason')]),
    ]);
    const evalSession = new EvalSession(runtime(def), META);
    const evaluator = (evalSession as unknown as { evaluator: Evaluator }).evaluator;
    return { evalSession, evaluate: vi.spyOn(evaluator, 'evaluate'), update: vi.spyOn(evaluator, 'update') };
  }

  it('evaluates in full once, then passes only the changed answers to update', () => {
    const { evalSession, evaluate, update } = session();
    const first = evalSession.evaluate({ name: { type: 'short_text', value: 'Asha' } });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(first.state.visible.has('reason' as BlockId)).toBe(false);

    const second = evalSession.evaluate({ name: { type: 'short_text', value: 'Asha' }, attending: { type: 'single_choice', value: { optionId: id<OptionId>('yes') } } });
    expect(update).toHaveBeenCalledTimes(1);
    expect([...(update.mock.calls[0]?.[1] ?? [])]).toEqual(['attending']);
    expect(second.answers['name' as BlockId]).toBe(first.answers['name' as BlockId]);
    expect(second.state.visible.has('reason' as BlockId)).toBe(true);

    evalSession.evaluate({ attending: { type: 'single_choice', value: { optionId: id<OptionId>('yes') } } });
    expect([...(update.mock.calls[1]?.[1] ?? [])]).toEqual(['name']);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('returns the same evaluation while the answers are unchanged, blank answers included', () => {
    const { evalSession, update } = session();
    const first = evalSession.evaluate({ name: { type: 'short_text', value: 'Asha' } });
    expect(evalSession.evaluate({ name: { type: 'short_text', value: 'Asha' }, reason: { type: 'short_text', value: '' } })).toBe(first);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('meta.now is frozen at session start', () => {
  /** A date that must not be after "today" (meta.today in the form's zone), defaulting to today. */
  const dated = () =>
    runtime(form([field('date', 'day', { required: true, config: { defaultValue: { kind: 'today' }, limits: { max: { kind: 'relative', offset: 0, unit: 'day' } } } })], [page('p1', ['day'])]));

  it('keeps the mount time through clock changes and new session props, for the payload, defaults and validation', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T18:00:00Z'));
    const submitted: SubmitPayload[] = [];
    const version = dated();
    const view = render(<FormRenderer {...props(version, { session: { device: 'desktop' }, onSubmit: (p) => void submitted.push(p) })} />);
    const day = screen.getByLabelText(/day/);
    expect(day).toHaveValue('2026-10-19');

    vi.setSystemTime(new Date('2026-10-20T03:00:00Z'));
    view.rerender(<FormRenderer {...props(version, { session: { device: 'mobile' }, onSubmit: (p) => void submitted.push(p) })} />);
    fireEvent.change(screen.getByLabelText(/day/), { target: { value: '2026-10-20' } });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.getByLabelText(/day/)).toHaveAttribute('aria-invalid', 'true'));
    expect(submitted).toEqual([]);

    fireEvent.change(screen.getByLabelText(/day/), { target: { value: '2026-10-19' } });
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.client).toEqual({ startedAt: '2026-10-19T18:00:00.000Z', device: 'mobile' });
    expect(submitted[0]?.answers['day' as BlockId]).toEqual({ type: 'date', value: '2026-10-19' as IsoDate });
  });

  it('"Submit another response" starts a new session with a new clock, unless the host pinned startedAt', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-19T04:30:00Z'));
    const submitted: SubmitPayload[] = [];
    const def = form([field('short_text', 'name')], [page('p1', ['name'])]);
    render(<FormRenderer {...props(runtime(def), { session: {}, onSubmit: (p) => void submitted.push(p) })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    vi.setSystemTime(new Date('2026-10-19T05:00:00Z'));
    await user.click(await screen.findByRole('button', { name: 'Submit another response' }));
    await user.click(await screen.findByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(submitted).toHaveLength(2));
    expect(submitted.map((p) => p.client.startedAt)).toEqual(['2026-10-19T04:30:00.000Z', '2026-10-19T05:00:00.000Z']);
  });

  it('a restart keeps a startedAt the host passed', async () => {
    const pinned: SubmitPayload[] = [];
    render(<FormRenderer {...props(runtime(form([field('short_text', 'name')], [page('p1', ['name'])])), { onSubmit: (p) => void pinned.push(p) })} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await user.click(await screen.findByRole('button', { name: 'Submit another response' }));
    await user.click(await screen.findByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(pinned).toHaveLength(2));
    expect(pinned.map((p) => p.client.startedAt)).toEqual([STARTED_AT, STARTED_AT]);
  });
});

describe('option shuffling', () => {
  const shuffled = () => {
    const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const config = { display: 'radio' as const, shuffle: { keepLast: 0 }, options: letters.map((l) => ({ id: id<OptionId>(l), label: l.toUpperCase() })) };
    return runtime(form([field('single_choice', 'pick', { config })], [page('p1', ['pick'])]));
  };
  const order = (startedAt: string) => {
    const view = render(<FormRenderer {...props(shuffled(), { session: { startedAt: startedAt as typeof STARTED_AT } })} />);
    const labels = screen.getAllByRole('radio').map((radio) => radio.getAttribute('value') ?? radio.closest('label')?.textContent ?? '');
    view.unmount();
    return labels;
  };

  it('is seeded per session: the same start gives the same order, another session another order', () => {
    const first = order('2026-10-19T04:30:00.000Z');
    expect(order('2026-10-19T04:30:00.000Z')).toEqual(first);
    expect(order('2026-10-19T04:31:00.000Z')).not.toEqual(first);
    expect([...first].sort()).toEqual([...order('2026-10-19T04:31:00.000Z')].sort());
  });
});
