import { editionSummary, loadEditionConfig } from '@form/config';
import { expect, test } from './test.ts';
import { openNewForm } from './helpers.ts';

/* FND-19: the edition matrix as the builder shows it, from `GET /v1/meta/edition` (mocked per case). */

const CASES = [
  { name: 'SaaS', env: { DEPLOYMENT_MODE: 'saas' }, label: 'SaaS', hint: /can be used/ },
  { name: 'on-prem, open egress', env: { DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'open' }, label: 'On-premises', hint: /can be used/ },
  { name: 'on-prem, allowlist', env: { DEPLOYMENT_MODE: 'onprem' }, label: 'On-premises · egress allowlist', hint: /operator enabled/ },
  { name: 'air-gapped', env: { DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none' }, label: 'On-premises · air-gapped', hint: /are off/ },
];

for (const c of CASES) {
  test.describe(c.name, () => {
    test.use({ edition: editionSummary(loadEditionConfig(c.env)) });

    test(`the forms list and the builder show ${c.label}`, async ({ page }) => {
      await page.goto('/forms');
      const badge = page.getByRole('note', { name: 'Edition' });
      await expect(badge).toHaveText(c.label);
      await expect(badge).toHaveAttribute('title', c.hint);
      await openNewForm(page);
      await expect(page.getByRole('note', { name: 'Edition' })).toHaveText(c.label);
      /* Every P0 field type runs in every edition: the palette is complete. */
      await expect(page.getByText('Short answer').first()).toBeVisible();
    });
  });
}

test.describe('API unreachable', () => {
  test.use({ edition: null });

  test('without a last-known edition the builder says so and assumes the restricted one', async ({ page }) => {
    await page.goto('/forms');
    const badge = page.getByRole('note', { name: 'Edition' });
    await expect(badge).toHaveText('Edition unknown');
    await expect(badge).toHaveAttribute('title', /hidden until it does/);
  });
});

test('an offline reload keeps the last known edition', async ({ page }) => {
  await page.route('**/v1/meta/edition', (route) => route.fulfill({ json: editionSummary(loadEditionConfig({ DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none' })) }));
  await page.goto('/forms');
  const badge = page.getByRole('note', { name: 'Edition' });
  await expect(badge).toHaveText('On-premises · air-gapped');
  await page.unroute('**/v1/meta/edition');
  await page.route('**/v1/meta/edition', (route) => route.abort('internetdisconnected'));
  await page.reload();
  await expect(badge).toHaveText('On-premises · air-gapped');
  await expect(badge).toHaveAttribute('title', /Last known/);
});
