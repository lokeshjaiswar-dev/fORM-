/*
 * SECURITY REVIEW PROOFS (SR-7, low): these tests FAIL on 21ccb166 on purpose. The upload checks are a denylist plus a
 * look at the first bytes; the download headers (attachment, octet-stream, nosniff, sandbox CSP) are what actually keep
 * a file from running. These cases get past the upload checks, so keep the download headers as the guarantee and
 * prefer an allowlist of (extension, magic) pairs over the denylist.
 */
import { describe, expect, it } from 'vitest';
import { contentProblem, isNeverStored } from './files.ts';

describe('SR-7: upload content checks', () => {
  it('sees markup behind a leading HTML comment', () => {
    const page = Buffer.from('<!-- note --><html><body><script>alert(document.domain)</script></body></html>');
    expect(contentProblem(page, 'notes.txt', 'text/plain')).toBe('markup');
  });

  it('sees markup that is not one of the listed opening tags', () => {
    expect(contentProblem(Buffer.from('<img src=x onerror=alert(1)>'), 'notes.txt', 'text/plain')).toBe('markup');
    expect(contentProblem(Buffer.from('<a href="javascript:alert(1)">open</a>'), 'notes.txt', 'text/plain')).toBe('markup');
  });

  it('refuses a program whose format sniff() does not know when it claims to be text', () => {
    const exe = Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00', 'latin1'), Buffer.alloc(32, 0x41)]);
    expect(contentProblem(exe, 'notes.txt', 'text/plain')).not.toBeNull();
    // A zip (a .jar, an .apk) named .txt passes too: zip and ole are let through when nothing is claimed.
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(32, 0)]);
    expect(contentProblem(zip, 'notes.txt', 'text/plain')).not.toBeNull();
  });

  it('never stores other extensions a browser or Windows opens as a page or a program', () => {
    for (const name of ['a.xht', 'a.mht', 'a.mhtml', 'a.chm', 'a.pif', 'a.cpl', 'a.msc', 'a.iso', 'a.img', 'a.vhd', 'a.one', 'a.xll', 'a.docm', 'a.xlsm', 'a.url', 'a.reg']) {
      expect(isNeverStored(name, 'application/octet-stream'), name).toBe(true);
    }
  });
});
