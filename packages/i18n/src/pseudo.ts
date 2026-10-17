import { TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';

export const PSEUDO_LOCALE = 'en-XA';
export const PSEUDO_OPEN = '⟦';
export const PSEUDO_CLOSE = '⟧';

const ACCENTS: Readonly<Record<string, string>> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ď', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'í', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ó', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'ú', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ď', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Í', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Ú', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

export function isPseudoLocale(locale: string): boolean {
  return locale.toLowerCase() === PSEUDO_LOCALE.toLowerCase();
}

function accent(text: string): string {
  let out = '';
  for (const ch of text) out += ACCENTS[ch] ?? ch;
  return out;
}

function transform(elements: MessageFormatElement[]): { elements: MessageFormatElement[]; letters: number } {
  let letters = 0;
  const out = elements.map((element): MessageFormatElement => {
    switch (element.type) {
      case TYPE.literal:
        letters += element.value.replace(/[^A-Za-z]/g, '').length;
        return { ...element, value: accent(element.value) };
      case TYPE.select:
      case TYPE.plural: {
        const options: typeof element.options = {};
        for (const [key, option] of Object.entries(element.options)) {
          const inner = transform(option.value);
          letters = Math.max(letters, inner.letters);
          options[key] = { ...option, value: inner.elements };
        }
        return { ...element, options };
      }
      case TYPE.tag: {
        const inner = transform(element.children);
        letters += inner.letters;
        return { ...element, children: inner.elements };
      }
      default:
        return element;
    }
  });
  return { elements: out, letters };
}

/**
 * en-XA: accents every literal letter, pads by ~40 % for layout testing and wraps the message in
 * ⟦ ⟧, so text that bypassed the catalogue stands out. Arguments, plural and select structure are kept.
 */
export function pseudoLocalizeAst(elements: MessageFormatElement[]): MessageFormatElement[] {
  const { elements: body, letters } = transform(elements);
  const padding = '·'.repeat(Math.ceil(letters * 0.4));
  return [
    { type: TYPE.literal, value: PSEUDO_OPEN },
    ...body,
    { type: TYPE.literal, value: padding + PSEUDO_CLOSE },
  ];
}

/** Currency prefixes `formatMoney` puts before the amount: an ISO code and (no-break) space, or `US$`. */
const CURRENCY_PREFIX = /(?<!\p{L})(?:[A-Z]{3}[  ]|US\$)(?=\d)/gu;

/**
 * Returns the fragments of rendered text that are outside every ⟦ ⟧ pair and contain a letter,
 * i.e. text a component rendered without going through the catalogue. Pass `textContent` of a
 * rendered tree under `en-XA`; digits, punctuation and formatted money (`US$1.00`, `JPY 100`) are allowed.
 */
export function findUnwrappedText(text: string): string[] {
  const fragments: string[] = [];
  let depth = 0;
  let current = '';
  const flush = () => {
    if (/\p{L}/u.test(current.replace(CURRENCY_PREFIX, ''))) fragments.push(current.trim());
    current = '';
  };
  for (const ch of text) {
    if (ch === PSEUDO_OPEN) {
      if (depth === 0) flush();
      depth++;
    } else if (ch === PSEUDO_CLOSE && depth > 0) {
      depth--;
    } else if (depth === 0) {
      current += ch;
    }
  }
  flush();
  return fragments;
}
