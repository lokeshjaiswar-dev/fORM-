import { expect, test } from './test.ts';

/*
 * The org switcher and the members page under the production CSP, with the API mocked (the flow against the real API
 * is orgs.stack.spec.ts).
 */

const ORGS = [
  { id: '01970000-0000-7000-8000-000000000001', slug: 'acme', name: 'Acme', role: 'owner' },
  { id: '01970000-0000-7000-8000-000000000011', slug: 'globex', name: 'Globex', role: 'viewer' },
];
const USER = { id: 'u1', email: 'asha@example.test', name: 'Asha', emailVerified: true, totpEnabled: false };

test('switches the org and shows its members', async ({ page }) => {
  let active = ORGS[0]!.id;
  const orgHeaders: string[] = [];
  await page.route('**/v1/me', (route) => route.fulfill({ json: { user: USER, session: null, orgs: ORGS, activeOrgId: active } }));
  await page.route('**/v1/me/active-org', async (route) => {
    active = (route.request().postDataJSON() as { orgId: string }).orgId;
    await route.fulfill({ status: 204 });
  });
  await page.route('**/v1/org', (route) => {
    orgHeaders.push(route.request().headers()['x-fr-org'] ?? '');
    const org = ORGS.find((o) => o.id === active)!;
    return route.fulfill({
      json: {
        org: { id: org.id, slug: org.slug, name: org.name, locale: 'en-IN', timeZone: 'Asia/Kolkata', dateFormat: 'DD-MM-YYYY' },
        role: org.role,
        permissions: org.role === 'owner' ? ['forms.read', 'members.manage', 'org.settings'] : ['forms.read'],
      },
    });
  });
  await page.route('**/v1/org/members', (route) =>
    route.fulfill({
      json: {
        items: [{ userId: 'u1', email: USER.email, name: 'Asha', role: active === ORGS[0]!.id ? 'owner' : 'viewer', status: 'active', joinedAt: '2026-10-01T00:00:00Z' }],
        accessLinks: false,
      },
    }),
  );
  await page.route('**/v1/org/invites', (route) => route.fulfill({ json: { items: [] } }));

  await page.goto('/forms');
  await expect(page.getByLabel('Organisation', { exact: true })).toHaveValue(ORGS[0]!.id);
  await page.getByRole('link', { name: 'Members' }).click();
  await expect(page.getByRole('heading', { name: 'Members of Acme' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite' })).toBeVisible();

  await page.getByLabel('Organisation', { exact: true }).selectOption({ label: 'Globex' });
  await expect(page.getByRole('heading', { name: 'Members of Globex' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite' })).toHaveCount(0);
  expect(orgHeaders).toEqual([ORGS[0]!.id, ORGS[1]!.id]);
});
