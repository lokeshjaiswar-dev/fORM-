import { describe, expect, it } from 'vitest';
import { acceptsFile, rankCount } from '../src/index.ts';
import { minutesOf, weekdayOf } from '../src/util/calendar.ts';
import { callingCodeOf, matchesCallingCode } from '../src/util/calling-codes.ts';
import { compareDecimal, isInteger, isStepOf, scaled } from '../src/util/decimal.ts';
import { asciiLower, inlineText, labelText } from '../src/util/text.ts';
import { EN_IN, id } from './fixtures.ts';
import { datePatternFor, hourCycleFor, message, regionOf, DEFAULT_TEXT } from '../src/messages.ts';

describe('decimal', () => {
  it('compares exactly, beyond float precision', () => {
    expect(compareDecimal('0.1000000001', '0.1')).toBe(1);
    expect(compareDecimal('-2', '-10')).toBe(1);
    expect(compareDecimal('12345678901234567890', '12345678901234567891')).toBe(-1);
    expect(compareDecimal('1.50', '1.5')).toBe(0);
    expect(compareDecimal('x', '1')).toBeNaN();
    expect(scaled('1e3')).toBeNull();
  });

  it('checks integers and steps', () => {
    expect(isInteger('-3')).toBe(true);
    expect(isInteger('3.1')).toBe(false);
    expect(isInteger('nope')).toBe(false);
    expect(isStepOf('0.3', '0.1')).toBe(true);
    expect(isStepOf('0.35', '0.1')).toBe(false);
    expect(isStepOf('7', '2', '1')).toBe(true);
    expect(isStepOf('1', '0')).toBe(false);
  });
});

describe('calendar', () => {
  it('computes weekdays without the host clock', () => {
    expect(weekdayOf('2024-06-02')).toBe(0);
    expect(weekdayOf('2024-02-29')).toBe(4);
    expect(weekdayOf('2000-01-01')).toBe(6);
    expect(weekdayOf('1947-08-15')).toBe(5);
  });

  it('reads wall-clock minutes', () => {
    expect(minutesOf('00:00')).toBe(0);
    expect(minutesOf('23:59')).toBe(1439);
  });
});

describe('text', () => {
  it('flattens inline docs and label templates', () => {
    expect(inlineText({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe('');
    expect(inlineText({
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'Hi' }, { type: 'hardBreak' }, { type: 'pipe', attrs: { source: { kind: 'meta', key: 'locale' }, fallback: 'there' } },
        { type: 'var', attrs: { name: 'org.legal_name' } },
      ] }],
    })).toBe('Hi there');
    expect(labelText(['Pay ', { pipe: { source: { kind: 'meta', key: 'locale' }, fallback: 'now' } }, { var: { name: 'org.x', fallback: '!' } }, { var: { name: 'org.y' } }])).toBe('Pay now!');
    expect(asciiLower('ÄBC-İ')).toBe('Äbc-İ');
  });
});

describe('locale defaults', () => {
  it('reads the region subtag', () => {
    expect(regionOf(id('en-IN'))).toBe('IN');
    expect(regionOf(id('zh-Hant-TW'))).toBe('TW');
    expect(regionOf(id('ta'))).toBe('IN');
    expect(datePatternFor(id('en-US'))).toBe('MM/DD/YYYY');
    expect(hourCycleFor(id('fr-FR'))).toBe('h23');
    expect(hourCycleFor(EN_IN)).toBe('h12');
  });

  it('formats default text and survives many locales', () => {
    for (let i = 0; i < 40; i += 1) message(id(`en-${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`), DEFAULT_TEXT['defaults.option'], { n: 1 });
    expect(message(id('hi-IN'), DEFAULT_TEXT['defaults.option'], { n: 2 })).toBe('Option 2');
  });
});

describe('file and ranking helpers', () => {
  it('matches extensions and MIME families case-insensitively', () => {
    const accept = { extensions: ['.PDF', 'png'], mimeTypes: ['application/pdf', 'image/*'] };
    expect(acceptsFile({ name: 'a.Pdf', mime: 'application/pdf' }, accept)).toBe(true);
    expect(acceptsFile({ name: 'a.png', mime: 'IMAGE/PNG' }, accept)).toBe(true);
    expect(acceptsFile({ name: 'README', mime: 'application/pdf' }, accept)).toBe(false);
    expect(acceptsFile({ name: 'a.png', mime: 'text/plain' }, accept)).toBe(false);
  });

  it('counts ranked positions', () => {
    const options = [{ id: id('a'), label: 'A' }, { id: id('b'), label: 'B' }];
    expect(rankCount({ options } as never)).toBe(2);
    expect(rankCount({ options, rankTop: 1 } as never)).toBe(1);
  });
});

describe('calling codes', () => {
  it('maps regions to E.164 calling codes, shared codes included', () => {
    expect(callingCodeOf(id('IN'))).toBe('91');
    expect(callingCodeOf(id('CA'))).toBe('1');
    expect(callingCodeOf(id('KZ'))).toBe('7');
    expect(callingCodeOf(id('ZZ'))).toBeUndefined();
  });

  it('checks the number prefix only for known regions', () => {
    expect(matchesCallingCode('+919812345678', id('IN'))).toBe(true);
    expect(matchesCallingCode('+14155550100', id('IN'))).toBe(false);
    expect(matchesCallingCode('+14165550100', id('CA'))).toBe(true);
    expect(matchesCallingCode('+14155550100', id('ZZ'))).toBe(true);
  });
});
