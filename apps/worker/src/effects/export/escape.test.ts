import { describe, expect, it } from 'vitest';
import { escapeCell } from './escape.ts';

describe('escapeCell (OWASP formula injection, WP-1.17)', () => {
  it.each([
    ["=cmd|' /C calc'!A0", "'=cmd|' /C calc'!A0"],
    ['+1', "'+1"],
    ['-1', "'-1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=1', "'\t=1"],
    [' =1', "' =1"],
  ])('puts an apostrophe in front of %j', (input, expected) => {
    expect(escapeCell(input)).toBe(expected);
  });

  it('also catches a formula behind white space, control characters and invisible characters', () => {
    // space, two spaces, LF, no-break space, ideographic space, zero-width space, BOM, a C0 control, word joiner
    const lead = [[0x20], [0x20, 0x20], [0x0a], [0xa0], [0x3000], [0x200b], [0xfeff], [0x01], [0x2060]].map((codes) => String.fromCharCode(...codes));
    for (const l of lead) expect(escapeCell(`${l}=1+1`), JSON.stringify(l)).toBe(`'${l}=1+1`);
  });

  it('escapes a cell that starts with a tab or a carriage return even when no formula follows', () => {
    expect(escapeCell('\tname')).toBe("'\tname");
    expect(escapeCell('\rname')).toBe("'\rname");
  });

  it('leaves plain text, digits without a sign and other scripts byte for byte', () => {
    for (const plain of ['Asha Kumar', '12345', '3.14', '0', 'a=b', 'x-y', 'e-mail@example.com', 'नमस्ते', 'வணக்கம்', '••••••', "'quoted", '"=1"', '']) {
      expect(escapeCell(plain)).toBe(plain);
    }
  });

  it('escapes once: the result is not formula-shaped, but a second pass would add a second apostrophe', () => {
    // The writers call it exactly once per cell; this documents why a caller must not pre-escape.
    expect(escapeCell(escapeCell('=1'))).toBe("'=1");
  });

  it('does not treat a lone white-space cell as a formula', () => {
    expect(escapeCell('   ')).toBe('   ');
  });
});
