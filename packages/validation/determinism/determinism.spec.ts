/// <reference lib="dom" />
import { expect, test } from '@playwright/test';
import { runCorpus } from '../test/corpus/determinism.ts';

/*
 * VAL-04 and schema §3.3.13: the regex corpus, presets, masks and validateAnswers give byte-identical
 * results in every engine. Node runs the corpus here, in the Playwright process; each browser runs the same
 * modules from the built harness page. Part of the `determinism` job, next to the logic@2 corpus.
 */

const node = runCorpus();
const nodeJson = JSON.stringify(node);

/** The first differing character, with some context on both sides. */
function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  return `at ${i}: node …${a.slice(Math.max(0, i - 40), i + 40)}… vs browser …${b.slice(Math.max(0, i - 40), i + 40)}…`;
}

test('the regex verdicts and FieldErrors are byte-identical to Node', async ({ page, browserName }) => {
  await page.goto('/');
  await page.waitForFunction(() => document.documentElement.dataset['ready'] === 'true');
  const raw = await page.evaluate(() => window.runValidationCorpus?.() ?? '');
  const browser = JSON.parse(raw) as typeof node;

  expect(browser.map((c) => c.name)).toEqual(node.map((c) => c.name));
  const diffs = node.flatMap((c, i) => {
    const json = browser[i]?.json ?? '';
    return json === c.json ? [] : [`${c.name} ${firstDifference(c.json, json)}`];
  });
  expect(diffs.slice(0, 10), `${diffs.length} of ${node.length} cases differ in ${browserName}`).toEqual([]);
  expect(raw === nodeJson, 'the whole payload is byte-identical').toBe(true);
  test.info().annotations.push({ type: 'determinism', description: `${browserName}: ${node.length} validation cases, ${nodeJson.length} bytes identical to Node` });
});
