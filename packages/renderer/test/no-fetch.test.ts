import { describe, expect, it } from 'vitest';

/*
 * T-LK-12: the renderer's only door to the network is the host's RemoteSource. A third-party API address, key or credential
 * never reaches the respondent's page, and no control may call out on its own.
 */

const sources = import.meta.glob<string>('../src/**/*.{ts,tsx}', { eager: true, query: '?raw', import: 'default' });
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"])\/\/.*$/gm, '$1');

describe('the renderer makes no network calls of its own', () => {
  it('finds its sources', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(30);
  });

  it('has no fetch, XMLHttpRequest, sendBeacon, WebSocket or EventSource in src', () => {
    const hits: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      code(text).split('\n').forEach((line, i) => {
        if (/\bfetch\s*\(|\bXMLHttpRequest\b|\bsendBeacon\b|\bnew\s+(WebSocket|EventSource)\b/.test(line)) hits.push(`${file}:${i + 1} ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
