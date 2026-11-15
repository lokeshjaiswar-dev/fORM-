import { describe, expect, it } from 'vitest';
import { parseSmtpUrl, scrubMailError } from './email-senders.ts';

describe('parseSmtpUrl', () => {
  it('reads the host, port, TLS mode and user name, and never the password', () => {
    expect(parseSmtpUrl('smtps://alice:s3cret@smtp.example.com:465')).toEqual({ host: 'smtp.example.com', port: 465, secure: true, username: 'alice' });
    expect(parseSmtpUrl('smtp://relay.example.com')).toEqual({ host: 'relay.example.com', port: 25, secure: false, username: null });
    expect(parseSmtpUrl('smtps://relay.example.com')).toEqual({ host: 'relay.example.com', port: 465, secure: true, username: null });
    expect(parseSmtpUrl('smtp://[::1]:2525')).toEqual({ host: '::1', port: 2525, secure: false, username: null });
    expect(parseSmtpUrl('smtp://me%40example.com:p%40ss@mail.example.com:587')?.username).toBe('me@example.com');
    expect(JSON.stringify(parseSmtpUrl('smtps://alice:s3cret@smtp.example.com:465'))).not.toContain('s3cret');
  });

  it('refuses anything that is not an smtp:// or smtps:// URL with a host', () => {
    for (const bad of ['', 'smtp://', 'https://smtp.example.com', 'http://169.254.169.254/', 'ftp://x.example', 'smtp.example.com:25', 'smtp://host with space', 'smtp://host\r\nRCPT TO:<x@y>', 'smtp://%zz@host', `smtp://${'a'.repeat(2100)}`]) {
      expect(parseSmtpUrl(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('scrubMailError', () => {
  it('replaces URLs, addresses and anything with an @, and control characters', () => {
    const out = scrubMailError('Invalid login: 535 5.7.8 for <priya@example.com> via smtps://user:pa55@smtp.example.com:465 (user:pa55@smtp.example.com)\r\nnext line');
    expect(out).toBe('Invalid login: 535 5.7.8 for <[address]> via [url] ([address]) next line');
    for (const secret of ['priya', 'pa55', 'smtps://', 'user:']) expect(out).not.toContain(secret);
  });

  it('keeps the plain words of a server’s complaint so the member can act on it', () => {
    expect(scrubMailError('Connection timeout')).toBe('Connection timeout');
    expect(scrubMailError('SMTP delivery failed: 535 Username and Password not accepted')).toBe('SMTP delivery failed: 535 Username and Password not accepted');
  });

  it('cuts a long message and returns an empty string for nothing', () => {
    const out = scrubMailError('x '.repeat(500));
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith('...')).toBe(true);
    expect(scrubMailError('')).toBe('');
  });
});
