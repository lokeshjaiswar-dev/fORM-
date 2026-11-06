import type { CurrencyCode, Locale, MinorUnits } from '@form/schema';
import { defineStub, defineStubBlock } from './define.ts';
import { regionOf } from './messages.ts';

const isIndia = (locale: Locale) => regionOf(locale) === 'IN';

/** Types whose `defaultConfig` is a draft that `configSchema` rejects; none now that repeating groups carry a placeholder child. */
export const DRAFT_DEFAULT_CONFIG_TYPES = [] as const satisfies readonly import('@form/schema').BlockType[];

export const payment = defineStub('payment', 'payments', (locale) => ({
  gateway: 'razorpay',
  currency: (isIndia(locale) ? 'INR' : 'USD') as CurrencyCode,
  amount: { kind: 'donation', suggested: [], min: '100' as MinorUnits, allowCustom: true },
  couponsEnabled: false,
  showTotal: true,
  holdUntilPaid: true,
}), (value) => (value.items ?? []).length === 0 && value.customAmount === undefined);

export const image = defineStubBlock('image', 'content', 'x-field:image', () => ({ image: { ref: 'brand.logo' }, widthPct: 100, align: 'center' }));
