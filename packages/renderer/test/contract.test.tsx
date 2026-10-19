// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AVAILABLE_TYPES } from '@form/registry';
import { ANSWER_VALUE_SCHEMAS, AnswersSchema, type AnswerValue, type FieldBlock, type ValueFieldType } from '@form/schema';
import { CONTROLS, FormRenderer, type SubmitPayload } from '../src/index.ts';
import { content, fakeUploader, field, form, page, props, rich, runtime } from './build.ts';

/*
 * The contract per available type (WP-0.10): render → answer → validate → clear → payload shape. Each case answers
 * through the control as a respondent would, checks that an empty required field blocks submit, that clearing
 * brings the error back, and that the submitted answer is exactly the stored shape (its zod twin accepts it).
 */

const REQUIRED = 'This field is required.';
const png = new Blob(['png'], { type: 'image/png' });

beforeEach(() => {
  const ctx = { beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), setTransform: vi.fn(), clearRect: vi.fn(), fillText: vi.fn(), set fillStyle(_v: string) {}, set font(_v: string) {}, set textBaseline(_v: string) {} };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback: BlobCallback) => callback(png));
});

interface Case {
  name: string;
  block: FieldBlock;
  answer: (user: UserEvent) => Promise<void>;
  /** Empties the answer through the UI; null when the control cannot be emptied (a chosen radio, a ranked list). */
  clear: ((user: UserEvent) => Promise<void>) | null;
  expected: AnswerValue | ((answer: AnswerValue) => void);
}

const box = (name: RegExp | string) => screen.getByRole('textbox', { name });
const group = (name: RegExp) => within(screen.getByRole('radiogroup', { name }));

const CASES: Case[] = [
  {
    name: 'short_text',
    block: field('short_text', 'q', { required: true }),
    answer: (user) => user.type(box(/q/), 'Asha'),
    clear: (user) => user.clear(box(/q/)),
    expected: { type: 'short_text', value: 'Asha' },
  },
  {
    name: 'long_text',
    block: field('long_text', 'q', { required: true }),
    answer: (user) => user.type(box(/q/), 'Two{enter}lines'),
    clear: (user) => user.clear(box(/q/)),
    expected: { type: 'long_text', value: 'Two\nlines' },
  },
  {
    name: 'email',
    block: field('email', 'q', { required: true }),
    answer: (user) => user.type(box(/q/), 'asha@example.in'),
    clear: (user) => user.clear(box(/q/)),
    expected: { type: 'email', value: { address: 'asha@example.in' } } as AnswerValue,
  },
  {
    name: 'phone',
    block: field('phone', 'q', { required: true }),
    answer: (user) => user.type(box(/q/), '098765 43210'),
    clear: (user) => user.clear(box(/q/)),
    expected: { type: 'phone', value: { e164: '+919876543210', country: 'IN' } } as AnswerValue,
  },
  {
    name: 'number',
    block: field('number', 'q', { required: true }),
    answer: (user) => user.type(box(/q/), '42.5'),
    clear: (user) => user.clear(box(/q/)),
    expected: { type: 'number', value: '42.5' } as AnswerValue,
  },
  {
    name: 'url',
    block: field('url', 'q', { required: true }),
    answer: (user) => user.type(box(/q/), 'https://example.com/a'),
    clear: (user) => user.clear(box(/q/)),
    expected: { type: 'url', value: 'https://example.com/a' },
  },
  {
    name: 'single_choice (radio)',
    block: field('single_choice', 'q', { required: true }),
    answer: (user) => user.click(screen.getByRole('radio', { name: 'Option 2' })),
    clear: null,
    expected: { type: 'single_choice', value: { optionId: 'option_2' } } as AnswerValue,
  },
  {
    name: 'single_choice (dropdown)',
    block: field('single_choice', 'q', { required: true, config: { display: 'dropdown' } }),
    answer: (user) => user.selectOptions(screen.getByRole('combobox', { name: /q/ }), 'Option 3'),
    clear: (user) => user.selectOptions(screen.getByRole('combobox', { name: /q/ }), 'Select…'),
    expected: { type: 'single_choice', value: { optionId: 'option_3' } } as AnswerValue,
  },
  {
    name: 'single_choice (Other)',
    block: field('single_choice', 'q', { required: true, config: { other: { enabled: true, textRequired: true } } }),
    answer: async (user) => {
      await user.click(screen.getByRole('radio', { name: 'Other' }));
      await user.type(screen.getByRole('textbox', { name: 'Your answer for Other' }), 'Mango');
    },
    clear: null,
    expected: { type: 'single_choice', value: { optionId: null, other: 'Mango' } } as AnswerValue,
  },
  {
    name: 'multi_choice (checkbox)',
    block: field('multi_choice', 'q', { required: true }),
    answer: async (user) => {
      await user.click(screen.getByRole('checkbox', { name: 'Option 1' }));
      await user.click(screen.getByRole('checkbox', { name: 'Option 3' }));
    },
    clear: async (user) => {
      await user.click(screen.getByRole('checkbox', { name: 'Option 1' }));
      await user.click(screen.getByRole('checkbox', { name: 'Option 3' }));
    },
    expected: { type: 'multi_choice', value: { optionIds: ['option_1', 'option_3'] } } as AnswerValue,
  },
  {
    name: 'multi_choice (dropdown)',
    block: field('multi_choice', 'q', { required: true, config: { display: 'dropdown', exclusiveOptionIds: ['option_3' as never] } }),
    answer: async (user) => {
      const toggle = screen.getByRole('button', { name: 'Select…' });
      if (toggle.getAttribute('aria-expanded') === 'false') await user.click(toggle);
      await user.click(screen.getByRole('checkbox', { name: 'Option 1' }));
      await user.click(screen.getByRole('checkbox', { name: 'Option 3' }));
    },
    clear: (user) => user.click(screen.getByRole('checkbox', { name: 'Option 3' })),
    expected: { type: 'multi_choice', value: { optionIds: ['option_3'] } } as AnswerValue,
  },
  {
    name: 'date',
    block: field('date', 'q', { required: true }),
    answer: async () => void fireEvent.change(screen.getByLabelText(/q/), { target: { value: '2026-10-21' } }),
    clear: async () => void fireEvent.change(screen.getByLabelText(/q/), { target: { value: '' } }),
    expected: { type: 'date', value: '2026-10-21' } as AnswerValue,
  },
  {
    name: 'time',
    block: field('time', 'q', { required: true }),
    answer: async () => void fireEvent.change(screen.getByLabelText(/q/), { target: { value: '09:30' } }),
    clear: async () => void fireEvent.change(screen.getByLabelText(/q/), { target: { value: '' } }),
    expected: { type: 'time', value: { start: '09:30' } } as AnswerValue,
  },
  {
    name: 'time (range)',
    block: field('time', 'q', { required: true, config: { range: { enabled: true } } }),
    answer: async () => {
      fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:30' } });
      fireEvent.change(screen.getByLabelText('End time'), { target: { value: '11:00' } });
    },
    clear: async () => {
      fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '' } });
      fireEvent.change(screen.getByLabelText('End time'), { target: { value: '' } });
    },
    expected: { type: 'time', value: { start: '09:30', end: '11:00' } } as AnswerValue,
  },
  {
    name: 'rating',
    block: field('rating', 'q', { required: true }),
    answer: (user) => user.click(group(/q/).getByRole('radio', { name: '4 of 5' })),
    clear: (user) => user.click(group(/q/).getByRole('radio', { name: '4 of 5' })),
    expected: { type: 'rating', value: 4 },
  },
  {
    name: 'linear_scale',
    block: field('linear_scale', 'q', { required: true, config: { min: 0, max: 5 } }),
    answer: (user) => user.click(group(/q/).getByRole('radio', { name: '0' })),
    clear: (user) => user.click(group(/q/).getByRole('radio', { name: '0' })),
    expected: { type: 'linear_scale', value: 0 },
  },
  {
    name: 'nps',
    block: field('nps', 'q', { required: true }),
    answer: async (user) => {
      await user.click(group(/q/).getByRole('radio', { name: '9' }));
      await user.keyboard('{ArrowRight}');
    },
    clear: (user) => user.click(group(/q/).getByRole('radio', { name: '10' })),
    expected: { type: 'nps', value: 10 },
  },
  {
    name: 'ranking',
    block: field('ranking', 'q', { required: true }),
    answer: (user) => user.click(screen.getByRole('button', { name: 'Move Option 1 down' })),
    clear: null,
    expected: { type: 'ranking', value: ['option_2', 'option_1', 'option_3'] } as AnswerValue,
  },
  {
    name: 'file_upload',
    block: field('file_upload', 'q', { required: true }),
    answer: (user) => user.upload(screen.getByLabelText(/q/), new File(['%PDF'], 'cv.pdf', { type: 'application/pdf' })),
    clear: (user) => user.click(screen.getByRole('button', { name: 'Remove cv.pdf' })),
    expected: (answer) => {
      expect(answer.type).toBe('file_upload');
      expect(answer.value).toEqual([expect.objectContaining({ name: 'cv.pdf', mime: 'application/pdf', sizeBytes: 4 })]);
    },
  },
  {
    name: 'signature (drawn)',
    block: field('signature', 'q', { required: true }),
    answer: async () => {
      const canvas = screen.getByRole('img', { name: /Signature pad/ });
      fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
      fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30 });
      fireEvent.pointerUp(window);
    },
    clear: (user) => user.click(screen.getByRole('button', { name: 'Clear' })),
    expected: (answer) => {
      expect(answer).toEqual({ type: 'signature', value: { method: 'drawn', file: expect.objectContaining({ name: 'signature.png', mime: 'image/png' }) } });
    },
  },
  {
    name: 'signature (typed)',
    block: field('signature', 'q', { required: true }),
    answer: async (user) => {
      const typeInstead = screen.queryByRole('button', { name: 'Type your name instead' });
      if (typeInstead) await user.click(typeInstead);
      await user.type(screen.getByRole('textbox', { name: 'Type your full name' }), 'Asha Rao');
      await user.tab();
    },
    clear: async (user) => {
      await user.clear(screen.getByRole('textbox', { name: 'Type your full name' }));
      await user.tab();
    },
    expected: (answer) => {
      expect(answer).toEqual({ type: 'signature', value: { method: 'typed', typedName: 'Asha Rao', file: expect.objectContaining({ mime: 'image/png' }) } });
    },
  },
];

async function submitIn(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Submit' }));
}

describe('control contract', () => {
  it('every available value type except hidden has a case; content types render', () => {
    const tested = new Set(CASES.map((c) => c.block.type));
    const values = AVAILABLE_TYPES.filter((t) => !['heading', 'paragraph', 'divider', 'hidden'].includes(t));
    expect(values.filter((t) => !tested.has(t as ValueFieldType))).toEqual([]);
    expect(Object.keys(CONTROLS).sort()).toEqual([...AVAILABLE_TYPES].sort());
  });

  it.each(CASES)('$name: render → answer → validate → clear → payload shape', async ({ block, answer, clear, expected }) => {
    const submitted: SubmitPayload[] = [];
    const upload = fakeUploader();
    const version = runtime(form([block], [page('p1', [block.id])]));
    render(<FormRenderer {...props(version, { uploader: upload.uploader, onSubmit: (p) => void submitted.push(p) })} />);
    const user = userEvent.setup();

    await submitIn(user);
    expect(await screen.findByText(REQUIRED)).toBeInTheDocument();
    expect(submitted).toEqual([]);

    await answer(user);
    await waitFor(() => expect(screen.queryByText(REQUIRED)).not.toBeInTheDocument());
    if (clear) {
      await clear(user);
      await submitIn(user);
      expect(await screen.findByText(REQUIRED)).toBeInTheDocument();
      expect(submitted).toEqual([]);
      await answer(user);
    }

    await submitIn(user);
    await waitFor(() => expect(submitted).toHaveLength(1));
    const payload = submitted[0] as SubmitPayload;
    const got = payload.answers[block.id] as AnswerValue;
    if (typeof expected === 'function') expected(got);
    else expect(got).toEqual(expected);
    expect(ANSWER_VALUE_SCHEMAS[block.type].safeParse(got).success).toBe(true);
    expect(AnswersSchema.safeParse(payload.answers).success).toBe(true);
    expect(payload).toMatchObject({ formVersionId: version.versionId, locale: 'en-IN', pageTrail: ['p1'], client: { startedAt: '2026-10-19T04:30:00Z' } });
    expect(await screen.findByRole('heading', { name: 'Thanks for your response!' })).toBeInTheDocument();
    if (block.type === 'file_upload' || block.type === 'signature') {
      expect(upload.requests.length).toBeGreaterThan(0);
      for (const request of upload.requests) expect(request).toMatchObject({ blockId: block.id, purpose: block.type === 'signature' ? 'signature' : 'file' });
    }
  });

  it('signature: the uploader receives a PNG Blob', async () => {
    const upload = fakeUploader();
    const block = field('signature', 'q');
    render(<FormRenderer {...props(runtime(form([block], [page('p1', ['q'])])), { uploader: upload.uploader })} />);
    const canvas = screen.getByRole('img', { name: /Signature pad/ });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(upload.requests).toHaveLength(1));
    const request = upload.requests[0];
    expect(request?.file).toBeInstanceOf(Blob);
    expect(request?.file.type).toBe('image/png');
  });

  describe('signature: a typed name is committed before Submit validates', () => {
    async function typedForm() {
      const submitted: SubmitPayload[] = [];
      const upload = fakeUploader();
      const block = field('signature', 'q', { required: true });
      render(<FormRenderer {...props(runtime(form([block], [page('p1', ['q'])])), { uploader: upload.uploader, onSubmit: (p) => void submitted.push(p) })} />);
      const user = userEvent.setup();
      const typeInstead = screen.queryByRole('button', { name: 'Type your name instead' });
      if (typeInstead) await user.click(typeInstead);
      return { submitted, upload, user, input: screen.getByRole('textbox', { name: 'Type your full name' }) };
    }

    it('Enter in the name submits with the signature', async () => {
      const { submitted, upload, user, input } = await typedForm();
      await user.type(input, 'Asha Rao{Enter}');
      await waitFor(() => expect(submitted).toHaveLength(1));
      expect(screen.queryByText(REQUIRED)).not.toBeInTheDocument();
      expect(submitted[0]?.answers['q' as never]).toMatchObject({ type: 'signature', value: { method: 'typed', typedName: 'Asha Rao' } });
      expect(upload.requests).toHaveLength(1);
    });

    it('clicking Submit straight after typing waits for the PNG and the upload', async () => {
      const { submitted, upload, user, input } = await typedForm();
      await user.type(input, 'Asha Rao');
      await user.click(screen.getByRole('button', { name: 'Submit' }));
      await waitFor(() => expect(submitted).toHaveLength(1));
      expect(screen.queryByText(REQUIRED)).not.toBeInTheDocument();
      expect(upload.requests).toHaveLength(1);
    });
  });

  it('signature: Submit right after a stroke waits for the PNG and the upload', async () => {
    const submitted: SubmitPayload[] = [];
    let encode: (png: Blob | null) => void = () => undefined;
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback: BlobCallback) => {
      encode = callback;
    });
    const block = field('signature', 'q', { required: true });
    render(<FormRenderer {...props(runtime(form([block], [page('p1', ['q'])])), { onSubmit: (p) => void submitted.push(p) })} />);
    const canvas = screen.getByRole('img', { name: /Signature pad/ });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { clientX: 40, clientY: 30 });
    fireEvent.pointerUp(window);
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(submitted).toEqual([]);
    encode(png);
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(screen.queryByText(REQUIRED)).not.toBeInTheDocument();
  });

  it('phone: an international number can be typed one key at a time', async () => {
    const submitted: SubmitPayload[] = [];
    const block = field('phone', 'q');
    render(<FormRenderer {...props(runtime(form([block], [page('p1', ['q'])])), { onSubmit: (p) => void submitted.push(p) })} />);
    const user = userEvent.setup();
    const input = box(/q/);
    await user.selectOptions(screen.getByRole('combobox'), 'GB');
    await user.type(input, '+44 20 7946 0958');
    expect(input).toHaveValue('+44 20 7946 0958');
    await user.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.answers['q' as never]).toEqual({ type: 'phone', value: { e164: '+442079460958', country: 'GB' } });
  });

  it('hidden: captures its URL parameter without any UI', async () => {
    const submitted: SubmitPayload[] = [];
    const block = field('hidden', 'source', { config: { source: { kind: 'url_param', name: 'ref' } } });
    const version = runtime(form([block, field('short_text', 'name')], [page('p1', ['source', 'name'])]));
    const { container } = render(<FormRenderer {...props(version, { session: { startedAt: '2026-10-19T04:30:00Z' as never, urlParams: { ref: 'newsletter' } }, onSubmit: (p) => void submitted.push(p) })} />);
    expect(container.querySelectorAll('input')).toHaveLength(1);
    await submitIn(userEvent.setup());
    await waitFor(() => expect(submitted).toHaveLength(1));
    expect(submitted[0]?.answers['source' as never]).toEqual({ type: 'hidden', value: 'newsletter' });
    expect(submitted[0]?.client.urlParams).toEqual({ ref: 'newsletter' });
  });

  it('content blocks render as headings, rich text and a rule', () => {
    const blocks = [
      content('heading', 'h', { level: 1, text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Section' }] }] } }),
      content('paragraph', 'p', { content: rich('Body text') }),
      content('divider', 'd', { lineStyle: 'dashed' }),
    ];
    const { container } = render(<FormRenderer {...props(runtime(form(blocks, [page('p1', ['h', 'p', 'd'])])))} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Section' })).toBeInTheDocument();
    expect(screen.getByText('Body text').tagName).toBe('P');
    expect(container.querySelector('hr.fr-divider')).toHaveAttribute('data-line', 'dashed');
  });
});
