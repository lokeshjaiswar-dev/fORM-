import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { RETURN, stubDms, type DmsStub, type SessionAnswer, type SessionRequest } from './support/dmsLaunch.ts';

/*
 * T-DMSINT-56 (SEC-DESIGN 7.3, 10.3 row 56) in a real browser against the production build and its CSP, under the ticket launch: a master
 * with a field holding records; the author deletes the block, saves, and meets the consent dialog. Cancel and a wrong name send nothing; the
 * right name sends `remove[{field_id, confirmed_name, confirmed_count}]` with every kept field listed, never an omission. DMS is a route stub
 * answering from the additive cases of dms-master-form.fixtures.json; the replay against the real routes is dms-api's.
 */

const fixtures = JSON.parse(readFileSync(new URL('../src/embed/master/__fixtures__/dms-master-form.fixtures.json', import.meta.url), 'utf8'));
type Case = { name: string; request: { body?: Record<string, unknown> }; response: { status: number; body: Record<string, unknown> } };
const byName = (name: string): Case => (fixtures.v2Cases.cases as Case[]).find((c) => c.name === name) as Case;

const MASTER = 'a1000000-0000-4000-8000-0000000000b1';
const CODE = 'b1000000-0000-4000-8000-000000000002';
const STORED = ['b1000000-0000-4000-8000-000000000001', CODE, 'b1000000-0000-4000-8000-000000000008', 'b1000000-0000-4000-8000-000000000009'];
const usage = (count: number) => ({
  success: true,
  message: 'Field usage retrieved successfully',
  data: {
    updated_at: '2026-11-26T09:30:00.000000Z',
    total_records: 12,
    fields: [
      { id: STORED[0], name: 'Vendor Name', records_with_value: 12 },
      { id: CODE, name: 'Vendor Code', records_with_value: count },
      { id: STORED[2], name: 'Tax Id', records_with_value: 9 },
      { id: STORED[3], name: 'Internal Note', records_with_value: 3 },
    ],
  },
});

interface Script {
  master?: Case;
  count?: number;
  /** Answers the nth PATCH (1-based); the default is the fixture's 200. */
  patch?: (nth: number) => SessionAnswer | undefined;
}

function dmsFor(script: Script = {}): { answer: (req: SessionRequest) => SessionAnswer | undefined } {
  let patches = 0;
  return {
    answer: (req) => {
      if (req.method === 'GET' && req.legacy === `/dms/v1/master/form/${MASTER}/field-usage`) return { status: 200, body: usage(script.count ?? 3) };
      if (req.method === 'GET' && req.legacy === `/dms/v1/master/form/${MASTER}`) return { status: 200, body: (script.master ?? byName('show-as-revealer')).response.body };
      if (req.method === 'PATCH' && req.legacy === `/dms/v1/master/form/${MASTER}`) {
        patches += 1;
        return script.patch?.(patches) ?? { status: 200, body: byName('patch-remove-confirmed').response.body };
      }
      return undefined;
    },
  };
}

const patches = (dms: DmsStub) => dms.sessionRequests().filter((r) => r.method === 'PATCH');
const usageCalls = (dms: DmsStub) => dms.sessionRequests().filter((r) => r.path.endsWith('/field-usage'));
const block = (page: Page, id: string) => page.locator(`[data-block-id="${id}"]`);

async function open(page: Page, script: Script = {}): Promise<DmsStub> {
  const dms = await stubDms(page, dmsFor(script));
  await dms.launch(page, dms.issue({ mode: 'dms-master', masterId: MASTER }));
  await expect(page.getByTestId('dms-master-builder')).toBeVisible();
  await expect(block(page, STORED[0]!)).toBeVisible();
  return dms;
}

/** Deletes a block with its own "Delete block" button, the way an author does. */
async function deleteBlock(page: Page, id: string): Promise<void> {
  await block(page, id).hover();
  await block(page, id).getByRole('button', { name: 'Delete block' }).click({ force: true });
}

/** No PATCH of the run omits a stored field without naming it in remove[]. */
function expectNoSilentOmission(dms: DmsStub): void {
  for (const r of patches(dms)) {
    const body = r.body as { form_builder_fields: Array<{ id: string }>; remove?: Array<{ field_id: string }> };
    const named = new Set([...body.form_builder_fields.map((f) => f.id), ...(body.remove ?? []).map((x) => x.field_id)]);
    for (const id of STORED) expect(named.has(id), `PATCH omits ${id} without a remove[] entry`).toBe(true);
  }
}

test('T-DMSINT-56: the dialog shows the count; cancel and a wrong name send nothing; the right name sends remove[] with every kept field', async ({ page }) => {
  const csp: string[] = [];
  page.on('console', (m) => m.text().includes('Content Security Policy') && csp.push(m.text()));
  const dms = await open(page);

  await deleteBlock(page, CODE);
  await expect(block(page, CODE)).toHaveCount(0);
  await expect(page.getByTestId('fp-removal-marks')).toContainText('1 field will be removed when you save');
  expect(patches(dms)).toHaveLength(0);

  // Save: counts first, then the dialog with the contract text.
  await page.getByRole('button', { name: 'Save to DMS' }).click();
  const dialog = page.getByTestId('fp-removal-dialog');
  await expect(dialog).toContainText('Removing Vendor Code deletes its value in 3 records. DMS cannot restore them.');
  expect(usageCalls(dms)).toHaveLength(1);
  expect(patches(dms)).toHaveLength(0);

  // A wrong name keeps the button off; nothing is sent.
  const confirm = page.getByTestId('fp-removal-confirm');
  await expect(confirm).toBeDisabled();
  await page.getByTestId('fp-removal-confirm-name').fill('vendor code');
  await expect(confirm).toBeDisabled();
  expect(patches(dms)).toHaveLength(0);

  // Cancel puts the block back and sends nothing.
  await page.getByTestId('fp-removal-cancel').click();
  await expect(dialog).toHaveCount(0);
  await expect(block(page, CODE)).toBeVisible();
  await expect(page.getByTestId('fp-removal-marks')).toHaveCount(0);
  expect(patches(dms)).toHaveLength(0);
  expect(page.url()).not.toContain(RETURN);

  // Again, and this time the exact name.
  await deleteBlock(page, CODE);
  await page.getByRole('button', { name: 'Save to DMS' }).click();
  await page.getByTestId('fp-removal-confirm-name').fill('Vendor Code');
  await expect(confirm).toBeEnabled();
  await confirm.click();

  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(page.url()).toBe(`${RETURN}?fp_status=saved&fp_master_id=${MASTER}`);
  expect(patches(dms)).toHaveLength(1);
  const patch = patches(dms)[0]!;
  expect(patch.path).toBe(`/api/dms/v1/formplus/s/master/form/${MASTER}`);
  const body = patch.body as { form_builder_fields: Array<{ id: string }>; remove: unknown };
  expect(body.remove).toEqual([{ field_id: CODE, confirmed_name: 'Vendor Code', confirmed_count: 3 }]);
  expect(body.form_builder_fields.map((f) => f.id)).toEqual([STORED[0], STORED[2], STORED[3]]);
  expect(patch.headers['authorization']).toMatch(/^Bearer fps1_[A-Za-z0-9_-]{43}$/);
  expectNoSilentOmission(dms);
  expect(dms.violations).toEqual([]);
  expect(csp).toEqual([]);
});

test('T-DMSINT-56: a field that gained records while the dialog was open is asked about again with the new count', async ({ page }) => {
  const grew = byName('patch-remove-count-grew').response.body;
  const dms = await open(page, {
    patch: (nth) => (nth === 1 ? { status: 409, body: { ...grew, message: 'More records now hold a value.', request_id: null, details: { field_id: CODE, actual: 5 } } } : undefined),
  });
  await deleteBlock(page, CODE);
  await page.getByRole('button', { name: 'Save to DMS' }).click();
  await page.getByTestId('fp-removal-confirm-name').fill('Vendor Code');
  await page.getByTestId('fp-removal-confirm').click();

  await expect(page.getByTestId('fp-removal-recount')).toBeVisible();
  await expect(page.getByTestId('fp-removal-dialog')).toContainText('deletes its value in 5 records');
  await expect(page.getByTestId('fp-removal-confirm-name')).toHaveValue('');
  await expect(page.getByTestId('fp-removal-confirm')).toBeDisabled();
  await page.getByTestId('fp-removal-confirm-name').fill('Vendor Code');
  await page.getByTestId('fp-removal-confirm').click();

  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(patches(dms).map((r) => (r.body as { remove: Array<{ confirmed_count: number }> }).remove[0]!.confirmed_count)).toEqual([3, 5]);
  expectNoSilentOmission(dms);
  expect(dms.violations).toEqual([]);
});

test('T-DMSINT-56: a refusal of the removal (FIELD_OMITTED) is shown with its reference and nothing is lost', async ({ page }) => {
  const dms = await open(page, { patch: () => ({ status: 422, body: { success: false, code: 'FIELD_OMITTED', message: 'x', request_id: '7e000000-0000-4000-8000-0000000000ff' } }) });
  await deleteBlock(page, CODE);
  await page.getByRole('button', { name: 'Save to DMS' }).click();
  await page.getByTestId('fp-removal-confirm-name').fill('Vendor Code');
  await page.getByTestId('fp-removal-confirm').click();
  await expect(page.getByText('The form no longer lists a field that is stored in DMS. Reload and try again.')).toBeVisible();
  await expect(page.getByText('Reference: 7e000000-0000-4000-8000-0000000000ff')).toBeVisible();
  await expect(page.getByTestId(`fp-removal-mark-${CODE}`)).toBeVisible();
  expect(page.url()).not.toContain(RETURN);
  expectNoSilentOmission(dms);
});

test('hidden and secret: a revealer toggles Secret and the PATCH carries the flag, every other field echoed with its flags', async ({ page }) => {
  // The master answer says can.reveal_fields true: the toggles are offered and the flag goes out with the field.
  const dms = await open(page);
  await block(page, CODE).click();
  const secret = page.getByRole('switch', { name: 'Secret field' });
  await expect(secret).toBeVisible();
  await secret.click();
  await page.getByRole('button', { name: 'Save to DMS' }).click();
  await expect(page.getByText('back in DMS')).toBeVisible();
  const sent = (patches(dms)[0]!.body as { form_builder_fields: Array<{ id: string; is_secret?: boolean; is_hidden?: boolean }> }).form_builder_fields;
  expect(sent.find((f) => f.id === CODE)).toMatchObject({ is_secret: true, is_hidden: false });
  expect(sent.find((f) => f.id === STORED[0])).toMatchObject({ is_secret: false, is_hidden: false });
  expect(patches(dms)[0]!.body).not.toHaveProperty('remove');
  expectNoSilentOmission(dms);
  expect(dms.violations).toEqual([]);
});

test('hidden and secret: a non-revealer gets the banner and no toggles, and their save echoes what they were given', async ({ page }) => {
  const dms = await open(page, { master: byName('show-as-non-revealer') });
  await expect(page.getByTestId('fp-hidden-count-banner')).toContainText('1 hidden field you cannot see is kept');
  await block(page, CODE).click();
  await expect(page.getByRole('switch', { name: 'Secret field' })).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Hidden field' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save to DMS' }).click();
  await expect(page.getByText('back in DMS')).toBeVisible();
  const body = patches(dms)[0]!.body as { form_builder_fields: Array<{ id: string }>; remove?: unknown };
  // The hidden field is not in what they were given, so it is neither sent nor removed: DMS keeps it.
  expect(body.form_builder_fields.map((f) => f.id)).toEqual([STORED[0], CODE, STORED[2]]);
  expect(body.remove).toBeUndefined();
  expect(usageCalls(dms)).toHaveLength(0);
  expect(dms.violations).toEqual([]);
});
