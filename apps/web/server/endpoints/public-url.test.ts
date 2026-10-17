import { describe, expect, it } from 'vitest';

import { readPublicUrl } from './public-url';

const read = (value: string | undefined) => readPublicUrl({ AW_PUBLIC_URL: value });

describe('readPublicUrl', () => {
  it('reports an unset or blank value', () => {
    expect(read(undefined)).toEqual({ ok: false, reason: 'AW_PUBLIC_URL is not set' });
    expect(read('  ')).toEqual({ ok: false, reason: 'AW_PUBLIC_URL is not set' });
  });

  it('accepts an https origin, with or without a trailing slash', () => {
    expect(read('https://aw.example.com')).toEqual({ ok: true, origin: 'https://aw.example.com' });
    expect(read('https://aw.example.com/')).toEqual({ ok: true, origin: 'https://aw.example.com' });
  });

  it('accepts http on a loopback host only', () => {
    expect(read('http://localhost:3000')).toEqual({ ok: true, origin: 'http://localhost:3000' });
    expect(read('http://127.0.0.1:3000')).toEqual({ ok: true, origin: 'http://127.0.0.1:3000' });
    expect(read('http://example.com').ok).toBe(false);
  });

  it('refuses a path, a query, a fragment and credentials', () => {
    for (const bad of [
      'https://aw.example.com/app',
      'https://aw.example.com/?a=1',
      'https://aw.example.com/#x',
      'https://user:pass@aw.example.com',
    ]) {
      expect(read(bad).ok, bad).toBe(false);
    }
  });

  it('refuses a value that is not a URL, without echoing it', () => {
    const result = read('not a url');
    expect(result).toEqual({ ok: false, reason: 'AW_PUBLIC_URL is not a URL' });
  });

  it('never puts the credentials of a rejected value in the reason', () => {
    expect(JSON.stringify(read('https://user:hunter2@aw.example.com'))).not.toContain('hunter2');
  });
});
