import { editionSummary, loadEditionConfig } from '@form/config';
import { expect, test } from './test.ts';
import { openNewForm } from './helpers.ts';

/* FND-19: every edition still loads the builder; the edition badge is not shown. */

const CASES = [
  { name: 'SaaS', env: { DEPLOYMENT_MODE: 'saas' } },
  { name: 'on-prem, open egress', env: { DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'open' } },
  { name: 'on-prem, allowlist', env: { DEPLOYMENT_MODE: 'onprem' } },
  { name: 'air-gapped', env: { DEPLOYMENT_MODE: 'onprem', EGRESS_POLICY: 'none' } },
];

for (const c of CASES) {
  test.describe(c.name, () => {
    test.use({ edition: editionSummary(loadEditionConfig(c.env)) });

    test('the forms list and the builder load', async ({ page }) => {
      await page.goto('/forms');
      await expect(page.getByRole('heading', { name: 'Forms', exact: true })).toBeVisible();
      await expect(page.getByRole('note', { name: 'Edition' })).toHaveCount(0);
      await openNewForm(page);
      await expect(page.getByRole('note', { name: 'Edition' })).toHaveCount(0);
      /* Every P0 field type runs in every edition: the palette is complete. */
      await expect(page.getByText('Short answer').first()).toBeVisible();
    });
  });
}

test.describe('API unreachable', () => {
  test.use({ edition: null });

  test('without a last-known edition the builder still loads', async ({ page }) => {
    await page.goto('/forms');
    await expect(page.getByRole('heading', { name: 'Forms', exact: true })).toBeVisible();
    await expect(page.getByRole('note', { name: 'Edition' })).toHaveCount(0);
  });
});
