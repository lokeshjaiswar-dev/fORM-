import { defineMessages } from '@form/i18n';
import { t } from '@/i18n';

const M = defineMessages('builder', {
  'review_age.now': 'less than a minute',
  'review_age.minutes': '{n, plural, one {# minute} other {# minutes}}',
  'review_age.hours': '{n, plural, one {# hour} other {# hours}}',
  'review_age.days': '{n, plural, one {# day} other {# days}}',
});

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long a response has waited, as a person says it: the largest whole unit (minutes, hours or days), never a fraction. */
export function ageText(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s >= DAY) return t(M['review_age.days'], { n: Math.floor(s / DAY) });
  if (s >= HOUR) return t(M['review_age.hours'], { n: Math.floor(s / HOUR) });
  if (s >= MINUTE) return t(M['review_age.minutes'], { n: Math.floor(s / MINUTE) });
  return t(M['review_age.now']);
}
