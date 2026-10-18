/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { runCorpus, runGraphemes } from '../test/corpus/determinism.ts';

/*
 * Schema §3.3.13: every engine's EvalState JSON must be byte-identical to Node's. Node runs the corpus
 * here, in the Playwright process; each browser runs the same modules from the built harness page.
 */

const node = { cases: runCorpus(), graphemes: runGraphemes() };
const nodeJson = JSON.stringify(node);

/** The first differing character, with some context on both sides. */
function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return `at ${i}: node …${a.slice(Math.max(0, i - 40), i + 40)}… vs browser …${b.slice(Math.max(0, i - 40), i + 40)}…`;
}

test('the corpus EvalState JSON and the grapheme replay are byte-identical to Node', async ({ page, browserName }) => {
  await page.goto('/');
  await page.waitForFunction(() => document.documentElement.dataset['ready'] === 'true');
  const raw = await page.evaluate(() => window.runDeterminismCorpus?.() ?? '');
  const browser = JSON.parse(raw) as typeof node;

  expect(browser.cases.map((c) => c.name)).toEqual(node.cases.map((c) => c.name));
  const diffs = node.cases.flatMap((c, i) => {
    const json = browser.cases[i]?.json ?? '';
    return json === c.json ? [] : [`${c.name} ${firstDifference(c.json, json)}`];
  });
  expect(diffs.slice(0, 10), `${diffs.length} of ${node.cases.length} cases differ in ${browserName}`).toEqual([]);

  /* BL-011: the pinned segmenter agrees with the golden corpus in this engine, not only with Node. */
  for (const { text, expected, actual } of browser.graphemes) expect(actual, `${browserName}: ${text}`).toEqual(expected);
  expect(browser.graphemes).toEqual(node.graphemes);

  expect(raw === nodeJson, 'the whole payload is byte-identical').toBe(true);
  test.info().annotations.push({ type: 'determinism', description: `${browserName}: ${node.cases.length} EvalStates, ${nodeJson.length} bytes identical to Node` });
});
