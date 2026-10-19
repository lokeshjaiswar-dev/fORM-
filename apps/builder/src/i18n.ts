import { EN_IN, createI18n, type MessageId, type MessageValues } from '@form/i18n';
import type { Locale, TimeZone } from '@form/schema';

/*
 * The builder's own text goes through @form/i18n: each module declares its en-IN source messages with
 * `defineMessages('builder', …)` next to the code that shows them, `pnpm i18n:extract` collects them into
 * locales/en-IN/builder.json, and `t` formats them. Other builder locales plug in here.
 */

/** The author's locale; also the default locale of the forms the builder creates. */
export const BUILDER_LOCALE = 'en-IN' as Locale;
export const BUILDER_TIME_ZONE = 'Asia/Kolkata' as TimeZone;

const i18n = createI18n(BUILDER_LOCALE, EN_IN);

export const t = (id: MessageId, values?: MessageValues): string => i18n.t(id, values);
