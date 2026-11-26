import { expect, test, type Page } from '@playwright/test';
import { RETURN, USER_B, stubDms, type DmsStub, type SessionRequest } from './support/dmsLaunch.ts';

/*
 * T-DMSINT-57 (SEC-DESIGN 10.3), production build (run through ~/bin/pw-gate): the launch cannot be steered from outside, and a lost
 * session does not lose the page.
 *
 *   a valid ticket for someone else, opened in a fresh tab without the verifier (or with another one)   the exchange fails, the launch
 *                                                                                                       error shows, nothing is loaded
 *   a reload of a launched page                                                                         "Session ended", no API call
 *   401 mid-save, reconnect as the same user                                                            the page is kept; the save is retried
 *   401 mid-save, reconnect as another user                                                             blocked; the new credential is never used
 */

const MASTER = 'b9000000-0000-4000-8000-000000000001';
const created = { status: 201, body: { success: true, data: { id: MASTER, name: 'Vendor', source: 'formplus', updated_at: 'T1' } } };
const answer = (req: SessionRequest) => (req.method === 'POST' && req.route === 'master/form' ? created : undefined);
const SEED = { name: 'Vendor', doctype_ids: [], folder_ids: [], classification: null } as const;

async function startMaster(page: Page): Promise<DmsStub> {
  const dms = await stubDms(page, { answer });
  await dms.launch(page, dms.issue({ mode: 'dms-master', seed: SEED }));
  const palette = page.getByRole('complementary').first();
  await palette.getByRole('button', { name: 'Email' }).click();
  await palette.getByRole('button', { name: 'Date' }).click();
  await expect(page.getByTestId('dms-master-builder')).toBeVisible();
  return dms;
}

const posts = (dms: DmsStub) => dms.sessionRequests().filter((r) => r.method === 'POST');

test('a ticket opened in a fresh tab without the verifier: the launch error shows, nothing is exchanged or loaded', async ({ page }) => {
  const dms = await stubDms(page, { answer });
  // The ticket was issued for a launch in some other tab; this tab never held its verifier.
  await dms.launch(page, dms.issue({ mode: 'dms-master', seed: SEED }), { withVerifier: false });
  await expect(page.getByRole('heading', { name: 'Go back to DMS and open the form again' })).toBeVisible();
  await expect(page.getByTestId('dms-master-builder')).toHaveCount(0);
  expect(dms.exchanges).toHaveLength(0);
  expect(dms.sessionRequests()).toHaveLength(0);
  expect(page.url()).not.toContain('fpt=');
});

test('a ticket with a verifier that is not its own: the exchange fails and the launch error shows', async ({ page }) => {
  const dms = await stubDms(page, { answer });
  const victim = dms.issue({ mode: 'dms-master', seed: SEED });
  const attacker = dms.issue({ mode: 'dms-master', seed: SEED });
  // The page holds the attacker's verifier but is opened with the victim's ticket.
  await dms.launch(page, { ...victim, verifier: attacker.verifier });
  await expect(page.getByRole('heading', { name: 'Go back to DMS and open the form again' })).toBeVisible();
  expect(dms.exchanges).toHaveLength(1);
  expect(dms.exchanges[0]!.ok).toBe(false);
  expect(dms.sessionRequests()).toHaveLength(0);
  expect(dms.credentials).toHaveLength(0);
});

test('the same ticket cannot be used twice: a replayed link shows the launch error', async ({ page }) => {
  const dms = await stubDms(page, { answer });
  const issued = dms.issue({ mode: 'dms-master', seed: SEED });
  await dms.launch(page, issued);
  await expect(page.getByTestId('dms-master-builder')).toBeVisible();
  const again = await page.context().newPage();
  await again.addInitScript((v) => sessionStorage.setItem('fp.lv', v), issued.verifier);
  await again.goto(`/embed/dms-master#fpt=${issued.ticket}`);
  await expect(again.getByRole('heading', { name: 'Go back to DMS and open the form again' })).toBeVisible();
  expect(dms.credentials).toHaveLength(1);
});

test('a reload of a launched page shows "Session ended" and makes no API call', async ({ page }) => {
  const dms = await startMaster(page);
  const before = dms.requests.length;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Session ended' })).toBeVisible();
  await expect(page.getByTestId('fp-reconnect-button')).toBeVisible();
  await expect(page.getByTestId('dms-master-builder')).toHaveCount(0);
  expect(dms.requests.length).toBe(before);
  expect(dms.exchanges).toHaveLength(1);
});

test('401 mid-save, reconnect as the same user: the page is kept and the save is retried', async ({ page }) => {
  const dms = await startMaster(page);
  const blocks = await page.locator('[data-block-id]').count();
  expect(blocks).toBeGreaterThan(0);
  dms.expireAll();

  await page.getByRole('button', { name: 'Save to DMS' }).click();
  const banner = page.getByTestId('fp-reconnect-banner');
  await expect(banner).toBeVisible();
  // The state is kept: the same blocks, the same page, no error screen.
  await expect(page.getByTestId('dms-master-builder')).toBeVisible();
  expect(await page.locator('[data-block-id]').count()).toBe(blocks);
  expect(posts(dms)).toHaveLength(1);

  await expect(page.getByTestId('fp-reconnect-button')).toBeEnabled();
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('fp-reconnect-button').click()]);
  expect(new URL(popup.url()).pathname).toBe('/dms-reconnect');

  // The DMS tab broadcasts the ticket; fORM- exchanges it with its in-memory verifier and the save runs again.
  await expect(page.getByText('back in DMS')).toBeVisible();
  expect(page.url()).toBe(`${RETURN}?fp_status=saved&fp_master_id=${MASTER}`);
  const sent = posts(dms);
  expect(sent).toHaveLength(2);
  expect(sent[0]!.status).toBe(401);
  expect(sent[1]!.status).toBe(201);
  expect(sent[1]!.headers['authorization']).not.toBe(sent[0]!.headers['authorization']);
  expect(sent[1]!.body).toEqual(sent[0]!.body);
  expect(dms.credentials).toHaveLength(2);
  expect(dms.credentials[0]!.userId).toBe(dms.credentials[1]!.userId);
  expect(dms.violations).toEqual([]);
});

test('401 mid-save, reconnect as another user: blocked, and the new credential is never used', async ({ page }) => {
  const dms = await startMaster(page);
  dms.expireAll();
  dms.reconnectAs(USER_B);

  await page.getByRole('button', { name: 'Save to DMS' }).click();
  await expect(page.getByTestId('fp-reconnect-banner')).toBeVisible();
  await expect(page.getByTestId('fp-reconnect-button')).toBeEnabled();
  await Promise.all([page.waitForEvent('popup'), page.getByTestId('fp-reconnect-button').click()]);

  await expect(page.getByRole('heading', { name: 'You are signed in as someone else' })).toBeVisible();
  await expect(page.getByTestId('dms-master-builder')).toHaveCount(0);
  // The exchange happened (it is how the other identity was seen) but the credential it returned was never put to use.
  expect(dms.credentials).toHaveLength(2);
  const intruder = dms.credentials[1]!;
  expect(intruder.userId).toBe(USER_B.id);
  expect(posts(dms)).toHaveLength(1);
  expect(dms.sessionRequests().every((r) => r.headers['authorization'] !== `Bearer ${intruder.credential}`)).toBe(true);
  expect(dms.haystack()).not.toContain(intruder.credential);
  expect(page.url()).not.toContain('fp_status=saved');
});

test('the page offers the reconnect without a failing request when the session is about to expire', async ({ page }) => {
  const dms = await stubDms(page, { answer });
  // 5 minutes and 2 seconds of absolute lifetime: the prompt is due 2 seconds after the launch.
  await dms.launch(page, dms.issue({ mode: 'dms-master', seed: SEED, absoluteExpiresIn: 302 }));
  await expect(page.getByTestId('dms-master-builder')).toBeVisible();
  await expect(page.getByTestId('fp-reconnect-banner')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('fp-reconnect-banner')).toContainText('ends in a few minutes');
  expect(dms.sessionRequests().filter((r) => r.status === 401)).toHaveLength(0);
});
