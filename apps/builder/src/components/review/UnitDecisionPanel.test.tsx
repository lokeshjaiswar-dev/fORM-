import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSessionStore } from '@/auth/client';
import { FORM, ME, SUB, decidedJson, detailJson, fakeReviewApi, json, problem, tokenFor, unitJson, type FakeReviewApi } from '@/components/review/fakeReviewApi';
import { UnitDecisionPanel } from '@/components/review/UnitDecisionPanel';
import type { ReviewDetail } from '@/persistence/reviewsApi';

const onDetail = vi.fn<(detail: ReviewDetail | null) => void>();
const onSettled = vi.fn<(status: string) => void>();
const onStale = vi.fn<() => void>();

function renderPanel() {
  return render(<UnitDecisionPanel formId={FORM} id={SUB} onDetail={onDetail} onSettled={onSettled} onStale={onStale} />);
}

const DECISION = /\/decisions$/;
const key = (api: FakeReviewApi, n: number) => api.to('POST', DECISION)[n]?.headers['idempotency-key'];

/** The unit's card, found by the name in its heading. */
const card = async (name: string) => {
  const heading = await screen.findByRole('heading', { name });
  const li = heading.closest('li');
  if (!li) throw new Error(`no card for ${name}`);
  return within(li);
};

beforeEach(() => {
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
  onDetail.mockReset();
  onSettled.mockReset();
  onStale.mockReset();
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('UnitDecisionPanel (WP-2.33)', () => {
  it('lists each unit with where it stands, whether it is required, who checks it and what was decided on it', async () => {
    fakeReviewApi({
      detail: () =>
        detailJson(
          {
            decisions: [
              { id: 'd1', unitId: 'u_docs', round: 1, decision: 'reject', reasonCode: 'missing_document', decidedAt: '2026-11-15T12:00:00.000Z', decidedBy: { userId: 'u9', name: 'Meera Shah' } },
              { id: 'd2', unitId: 'u_docs', round: 2, decision: 'approve', reasonCode: null, decidedAt: '2026-11-15T13:00:00.000Z', decidedBy: { userId: 'u8', name: null } },
            ],
          },
          [
            unitJson('u_id', 'Identity check', { groupName: 'Finance', required: true }),
            unitJson('u_docs', 'Documents', { state: 'approved', round: 2, required: false, groupName: 'Legal', canDecide: false, yours: false, answersHash: null }),
            unitJson('u_late', 'Final sign-off', { order: 2, blocked: true, canDecide: false }),
          ],
        ),
    });
    renderPanel();

    const identity = await card('Identity check');
    expect(identity.getByText('Waiting for a checker')).toBeInTheDocument();
    expect(identity.getByText('Required')).toBeInTheDocument();
    expect(identity.getByText('Checked by Finance')).toBeInTheDocument();
    expect(identity.getByRole('button', { name: 'Approve Identity check' })).toBeEnabled();

    const docs = await card('Documents');
    expect(docs.getByText('Approved')).toBeInTheDocument();
    expect(docs.getByText('Optional')).toBeInTheDocument();
    expect(docs.getByText('Checked by Legal · Round 2')).toBeInTheDocument();
    const history = docs.getByRole('list', { name: 'History of Documents' });
    expect(within(history).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Rejected by Meera Shah, 15 Nov 2026, 5:30 pm: Missing document',
      'Approved by a checker, 15 Nov 2026, 6:30 pm',
    ]);
    // A unit that is not theirs, or is already decided, has no buttons.
    expect(docs.queryByRole('button')).not.toBeInTheDocument();

    const late = await card('Final sign-off');
    expect(late.getByText('This unit waits until the earlier steps are approved.')).toBeInTheDocument();
    expect(late.queryByRole('button')).not.toBeInTheDocument();
    await waitFor(() => expect(onDetail).toHaveBeenCalledWith(expect.objectContaining({ units: expect.any(Array) })));
  });

  it('says so when own_unit hides other units’ answers from the checker', async () => {
    fakeReviewApi({ detail: () => detailJson({ redacted: true }) });
    renderPanel();
    expect(await screen.findByText(/You see only the answers of the units you check/)).toBeInTheDocument();
  });

  it('tells a checker who is in a unit’s group but may not decide it why they have no buttons', async () => {
    fakeReviewApi({ detail: () => detailJson({}, [unitJson('u_id', 'Identity check', { canDecide: false })]) });
    renderPanel();
    const identity = await card('Identity check');
    expect(identity.getByText(/You cannot review a unit you filled in or changed/)).toBeInTheDocument();
    expect(identity.queryByRole('button')).not.toBeInTheDocument();
  });

  it('keeps Reject disabled until a reason is chosen, and sends the reason with the answersHash the checker read', async () => {
    const api = fakeReviewApi({ decide: () => json(200, decidedJson('u_id', { decision: 'reject', reasonCode: 'incorrect', unitState: 'rejected', submissionStatus: 'rejected' })) });
    const user = userEvent.setup();
    renderPanel();
    const identity = await card('Identity check');

    const reject = identity.getByRole('button', { name: 'Reject Identity check' });
    expect(reject).toBeDisabled();
    await user.click(reject);
    expect(api.to('POST', DECISION)).toHaveLength(0);

    await user.selectOptions(identity.getByRole('combobox', { name: 'Reason for rejecting Identity check' }), 'incorrect');
    expect(reject).toBeEnabled();
    await user.click(reject);

    await waitFor(() => expect(api.to('POST', DECISION)).toHaveLength(1));
    const [call] = api.to('POST', DECISION);
    expect(call?.path).toBe(`/v1/forms/${FORM}/submissions/${SUB}/review/units/u_id/decisions`);
    expect(call?.body).toEqual({ decision: 'reject', reasonCode: 'incorrect', answersHash: tokenFor('u_id') });
    expect(call?.headers['idempotency-key']).toBeTruthy();
    // A reject of a required unit settles the response.
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith('rejected'));
  });

  it('lists every reason of the catalogue and nothing else', async () => {
    fakeReviewApi();
    renderPanel();
    const identity = await card('Identity check');
    const select = identity.getByRole('combobox', { name: 'Reason for rejecting Identity check' });
    expect(within(select).getAllByRole('option').map((o) => [o.getAttribute('value'), o.textContent])).toEqual([
      ['', 'Reason (needed to reject)'],
      ['incomplete', 'Incomplete'],
      ['incorrect', 'Incorrect'],
      ['missing_document', 'Missing document'],
      ['duplicate', 'Duplicate'],
      ['other', 'Other'],
    ]);
  });

  it('approves without a reason, reads the review again, and tells the pane when the response is complete', async () => {
    const api = fakeReviewApi({
      detail: (n) =>
        n === 1
          ? detailJson()
          : detailJson(
              { submission: { ...detailJson().submission, status: 'complete' }, decisions: [{ id: 'd1', unitId: 'u_id', round: 1, decision: 'approve', reasonCode: null, decidedAt: '2026-11-16T09:00:00.000Z', decidedBy: { userId: 'u1', name: 'Asha' } }] },
              [unitJson('u_id', 'Identity check', { state: 'approved', canDecide: false })],
            ),
      decide: () => json(200, decidedJson('u_id', { submissionStatus: 'complete' })),
    });
    const user = userEvent.setup();
    renderPanel();

    // A reason picked and then not needed: an approve carries none.
    const identity = await card('Identity check');
    await user.selectOptions(identity.getByRole('combobox', { name: 'Reason for rejecting Identity check' }), 'other');
    await user.click(identity.getByRole('button', { name: 'Approve Identity check' }));

    await waitFor(() => expect(api.to('GET', /\/review$/)).toHaveLength(2));
    expect(api.to('POST', DECISION)[0]?.body).toEqual({ decision: 'approve', answersHash: tokenFor('u_id') });
    expect(onSettled).toHaveBeenCalledWith('complete');
    const after = await card('Identity check');
    await waitFor(() => expect(after.getByText('Approved')).toBeInTheDocument());
    expect(after.queryByRole('button', { name: 'Approve Identity check' })).not.toBeInTheDocument();
    expect(after.getByText('Identity check is approved.')).toBeInTheDocument();
    expect(screen.getByText('Every required unit is approved, so the response is complete.')).toBeInTheDocument();
  });

  it('on 409 REVIEW_STALE reloads the review detail, says why, tells the pane to read the answers again, and decides on the new answers next', async () => {
    const api = fakeReviewApi({
      detail: (n) => detailJson({}, [unitJson('u_id', 'Identity check', { answersHash: tokenFor('u_id', n) })]),
      decide: (n) => (n === 1 ? problem(409, 'REVIEW_STALE') : json(200, decidedJson('u_id'))),
    });
    const user = userEvent.setup();
    renderPanel();
    const identity = await card('Identity check');
    await user.click(identity.getByRole('button', { name: 'Approve Identity check' }));

    expect(await screen.findByText(/The answers changed after you read them, so nothing was saved/)).toBeInTheDocument();
    await waitFor(() => expect(api.to('GET', /\/review$/)).toHaveLength(2));
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onSettled).not.toHaveBeenCalled();

    // The next click names the answers as they are now, under a key of its own.
    await user.click((await card('Identity check')).getByRole('button', { name: 'Approve Identity check' }));
    await waitFor(() => expect(api.to('POST', DECISION)).toHaveLength(2));
    expect(api.to('POST', DECISION)[1]?.body).toEqual({ decision: 'approve', answersHash: tokenFor('u_id', 2) });
    expect(key(api, 1)).toBeTruthy();
    expect(key(api, 1)).not.toBe(key(api, 0));
  });

  it('on 403 FOUR_EYES_VIOLATION says you cannot review a unit you filled in or changed, and takes the buttons away instead of offering them again', async () => {
    const api = fakeReviewApi({ decide: () => problem(403, 'FOUR_EYES_VIOLATION', 'internal: maker_user_id matches') });
    const user = userEvent.setup();
    renderPanel();
    const identity = await card('Identity check');
    await user.click(identity.getByRole('button', { name: 'Approve Identity check' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot review a unit you filled in or changed. Another checker has to decide it.');
    expect(screen.queryByText(/maker_user_id/)).not.toBeInTheDocument();
    expect(within((await card('Identity check')).getByRole('alert')).queryByRole('button')).not.toBeInTheDocument();
    expect((await card('Identity check')).queryByRole('button', { name: 'Approve Identity check' })).not.toBeInTheDocument();
    // Nothing was decided, so nothing is settled.
    expect(onSettled).not.toHaveBeenCalled();
    expect(api.to('POST', DECISION)).toHaveLength(1);
  });

  it('on 403 NOT_IN_REVIEW_GROUP says you are not one of the checkers of the unit', async () => {
    fakeReviewApi({ decide: () => problem(403, 'NOT_IN_REVIEW_GROUP') });
    const user = userEvent.setup();
    renderPanel();
    await user.click((await card('Identity check')).getByRole('button', { name: 'Approve Identity check' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You are not one of the checkers for this unit.');
  });

  it('on 403 MFA_REQUIRED says to turn on two-factor sign-in, and leaves the buttons for the next try', async () => {
    fakeReviewApi({ decide: () => problem(403, 'MFA_REQUIRED') });
    const user = userEvent.setup();
    renderPanel();
    await user.click((await card('Identity check')).getByRole('button', { name: 'Approve Identity check' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your organisation asks checkers to sign in with two-factor authentication. Turn it on under Security, sign in again, then try again.');
    expect((await card('Identity check')).getByRole('button', { name: 'Approve Identity check' })).toBeEnabled();
  });

  it('on 409 REVIEW_CLOSED and REVIEW_ORDER_BLOCKED says so and reads the review again', async () => {
    const api = fakeReviewApi({ decide: (n) => (n === 1 ? problem(409, 'REVIEW_CLOSED') : problem(409, 'REVIEW_ORDER_BLOCKED')) });
    const user = userEvent.setup();
    renderPanel();
    await user.click((await card('Identity check')).getByRole('button', { name: 'Approve Identity check' }));
    expect(await screen.findByText(/This unit was already decided, so nothing was saved/)).toBeInTheDocument();
    await waitFor(() => expect(api.to('GET', /\/review$/)).toHaveLength(2));

    await user.click((await card('Identity check')).getByRole('button', { name: 'Approve Identity check' }));
    expect(await screen.findByText(/An earlier step has to be approved first/)).toBeInTheDocument();
    await waitFor(() => expect(api.to('GET', /\/review$/)).toHaveLength(3));
  });

  it('after a network error says the press can be repeated, and the repeat is sent under the same Idempotency-Key', async () => {
    const api = fakeReviewApi({ decide: (n) => (n === 1 ? new TypeError('network down') : json(200, decidedJson('u_id'))) });
    const user = userEvent.setup();
    renderPanel();
    await user.click((await card('Identity check')).getByRole('button', { name: 'Approve Identity check' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be reached.*not recorded twice/);

    await user.click((await card('Identity check')).getByRole('button', { name: 'Approve Identity check' }));
    await waitFor(() => expect(api.to('POST', DECISION)).toHaveLength(2));
    expect(key(api, 0)).toBeTruthy();
    expect(key(api, 1)).toBe(key(api, 0));
  });

  it('shows one plain sentence for any other refusal, never the server’s words', async () => {
    fakeReviewApi({ decide: (n) => (n === 1 ? problem(403, 'FORBIDDEN', 'Requires submissions.review.') : problem(422, 'IDEMPOTENCY_KEY_REUSED', 'internal')) });
    const user = userEvent.setup();
    renderPanel();
    await user.click((await card('Identity check')).getByRole('button', { name: 'Approve Identity check' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your role in this organisation does not allow that.');
    await user.click((await card('Identity check')).getByRole('button', { name: 'Approve Identity check' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The decision could not be saved. Try again.'));
    expect(screen.queryByText(/Requires submissions.review|internal/)).not.toBeInTheDocument();
  });

  it('shows a failed read with a way to try again, and does not give the pane a review it does not have', async () => {
    const api = fakeReviewApi({ detail: (n) => (n === 1 ? problem(503, 'UNAVAILABLE') : detailJson()) });
    const user = userEvent.setup();
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('This is not available right now. Try again in a moment.');
    await waitFor(() => expect(onDetail).toHaveBeenCalledWith(null));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await card('Identity check')).toBeTruthy();
    expect(api.to('GET', /\/review$/)).toHaveLength(2);
  });

  it('keeps the review on screen when a later read fails', async () => {
    fakeReviewApi({ detail: (n) => (n === 1 ? detailJson() : new TypeError('network down')), decide: () => problem(409, 'REVIEW_CLOSED') });
    const user = userEvent.setup();
    renderPanel();
    await user.click((await card('Identity check')).getByRole('button', { name: 'Approve Identity check' }));
    expect(await screen.findByText(/This unit was already decided/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Identity check' })).toBeInTheDocument();
    expect(onDetail).not.toHaveBeenCalledWith(null);
  });
});
