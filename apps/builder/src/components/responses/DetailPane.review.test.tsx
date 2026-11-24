import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { useSessionStore } from '@/auth/client';
import { formatWhen } from '@/components/responses/format';
import { DetailPane } from '@/components/responses/DetailPane';
import { FORM, ME, SUB, decidedJson, detailJson, fakeReviewApi, json, problem, tokenFor, unitJson, type Call, type FakeReviewApi } from '@/components/review/fakeReviewApi';

/** A response as `GET /v1/forms/:id/submissions/:id` answers it (the plain read), held for review unless a test says otherwise. */
const plain = (over: Record<string, unknown> = {}) => ({
  id: SUB,
  formId: FORM,
  receivedAt: '2026-11-15T10:00:00.000Z',
  status: 'pending_review',
  read: true,
  starred: false,
  archivedAt: null,
  trashedAt: null,
  versionNumber: 2,
  locale: 'en-IN',
  fields: [{ id: 'b_name', key: 'name', label: 'Name', type: 'short_text', value: 'Plain Reading', masked: false }],
  files: [],
  review: [{ name: 'Identity check', state: 'pending' }],
  ...over,
});

const PLAIN_PATH = `/v1/forms/${FORM}/submissions/${SUB}`;
const DECISION = /\/decisions$/;

interface Setup {
  plain?: (n: number) => unknown;
  review?: (n: number) => unknown;
  decide?: (n: number, call: Call) => Response | Error;
}

let plainReads = 0;
function setup(o: Setup = {}): FakeReviewApi {
  plainReads = 0;
  return fakeReviewApi({
    ...(o.review ? { detail: o.review } : {}),
    ...(o.decide ? { decide: o.decide } : {}),
    other: (call) => {
      if (call.method === 'GET' && call.path === PLAIN_PATH) {
        plainReads += 1;
        return o.plain ? o.plain(plainReads) : plain();
      }
      return undefined;
    },
  });
}

const onStatus = vi.fn<(id: string, status: string) => void>();

function renderPane() {
  return render(
    <MemoryRouter>
      <DetailPane formId={FORM} id={SUB} hasPrevious={false} hasNext={false} onPrevious={() => {}} onNext={() => {}} onClose={() => {}} onFlags={() => {}} onStatus={onStatus} />
    </MemoryRouter>,
  );
}

const pane = () => screen.getByRole('complementary', { name: 'Response' });

beforeEach(() => {
  useSessionStore.setState({ status: 'signed_in', me: ME }, true);
  onStatus.mockReset();
});

afterEach(() => {
  useSessionStore.setState({ status: 'unknown' }, true);
  vi.unstubAllGlobals();
});

describe('DetailPane of a response held for review (WP-2.33)', () => {
  it('shows the review units above the answers, and says the response is under review', async () => {
    setup();
    renderPane();
    expect(await within(pane()).findByRole('heading', { name: 'Identity check' })).toBeInTheDocument();
    expect(within(pane()).getByText(/Under review · v2 · en-IN/)).toBeInTheDocument();
    expect(within(pane()).getByRole('heading', { name: 'Review' })).toBeInTheDocument();
  });

  it('shows the answers of the review read, whose token a decision names, not those of the plain read', async () => {
    setup();
    renderPane();
    await within(pane()).findByRole('heading', { name: 'Identity check' });
    expect(await within(pane()).findByText('Ravi Kumar')).toBeInTheDocument();
    expect(within(pane()).queryByText('Plain Reading')).not.toBeInTheDocument();
  });

  it('shows the plain answers while the review is not read, and when it cannot be', async () => {
    setup({ review: () => problem(503, 'UNAVAILABLE') });
    renderPane();
    expect(await within(pane()).findByText('Plain Reading')).toBeInTheDocument();
    expect(await within(pane()).findByText('This is not available right now. Try again in a moment.')).toBeInTheDocument();
  });

  it('tells the grid, and shows Complete, when the decision settles the response', async () => {
    const api = setup({
      decide: () => json(200, decidedJson('u_id', { submissionStatus: 'complete' })),
      review: (n) => (n === 1 ? detailJson() : detailJson({ submission: { ...detailJson().submission, status: 'complete' } }, [unitJson('u_id', 'Identity check', { state: 'approved', canDecide: false })])),
    });
    const user = userEvent.setup();
    renderPane();
    await user.click(await within(pane()).findByRole('button', { name: 'Approve Identity check' }));

    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(SUB, 'complete'));
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(await within(pane()).findByText(/Complete · v2 · en-IN/)).toBeInTheDocument();
    expect(api.to('POST', DECISION)).toHaveLength(1);
  });

  it('does not tell the grid anything when a decision leaves the response under review', async () => {
    setup({ decide: () => json(200, decidedJson('u_id', { submissionStatus: 'pending_review' })) });
    const user = userEvent.setup();
    renderPane();
    await user.click(await within(pane()).findByRole('button', { name: 'Approve Identity check' }));
    await waitFor(() => expect(screen.getByText('Identity check is approved.')).toBeInTheDocument());
    expect(onStatus).not.toHaveBeenCalled();
    expect(within(pane()).getByText(/Under review/)).toBeInTheDocument();
  });

  it('on a stale decision reads the response again too, so the answers on screen are the ones the next decision names', async () => {
    const api = setup({
      plain: (n) => plain({ fields: [{ id: 'b_name', key: 'name', label: 'Name', type: 'short_text', value: `Plain ${n}`, masked: false }] }),
      review: (n) =>
        detailJson({ fields: [{ id: 'b_name', key: 'name', label: 'Name', type: 'short_text', value: n === 1 ? 'Ravi Kumar' : 'Ravi Kumar (corrected)', masked: false }] }, [
          unitJson('u_id', 'Identity check', { answersHash: tokenFor('u_id', n) }),
        ]),
      decide: () => problem(409, 'REVIEW_STALE'),
    });
    const user = userEvent.setup();
    renderPane();
    await user.click(await within(pane()).findByRole('button', { name: 'Approve Identity check' }));

    expect(await within(pane()).findByText('Ravi Kumar (corrected)')).toBeInTheDocument();
    await waitFor(() => expect(plainReads).toBe(2));
    expect(api.to('GET', /\/review$/)).toHaveLength(2);
  });

  it('never asks for a review of a response that was not held for one, and shows no Review section', async () => {
    const api = setup({ plain: () => plain({ status: 'complete', review: undefined }) });
    renderPane();
    expect(await within(pane()).findByText('Plain Reading')).toBeInTheDocument();
    expect(within(pane()).queryByRole('heading', { name: 'Review' })).not.toBeInTheDocument();
    expect(api.to('GET', /\/review$/)).toHaveLength(0);
  });

  it('shows the units of a response that was reviewed and is complete now, with its history and no buttons', async () => {
    setup({
      plain: () => plain({ status: 'complete', review: [{ name: 'Identity check', state: 'approved' }] }),
      review: () =>
        detailJson(
          { submission: { ...detailJson().submission, status: 'complete' }, decisions: [{ id: 'd1', unitId: 'u_id', round: 1, decision: 'approve', reasonCode: null, decidedAt: '2026-11-16T09:00:00.000Z', decidedBy: { userId: 'u9', name: 'Meera Shah' } }] },
          [unitJson('u_id', 'Identity check', { state: 'approved', canDecide: false })],
        ),
    });
    renderPane();
    expect(await within(pane()).findByText(`Approved by Meera Shah, ${formatWhen('2026-11-16T09:00:00.000Z')}`)).toBeInTheDocument();
    expect(within(pane()).queryByRole('button', { name: /Approve|Reject/ })).not.toBeInTheDocument();
    expect(within(pane()).getByText('Every required unit is approved, so the response is complete.')).toBeInTheDocument();
  });

  it('treats a response with the status pending_review as held for review even if the API sent no summary', async () => {
    const api = setup({ plain: () => plain({ review: undefined }) });
    renderPane();
    await within(pane()).findByRole('heading', { name: 'Identity check' });
    expect(api.to('GET', /\/review$/)).toHaveLength(1);
  });
});
