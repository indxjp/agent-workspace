import { describe, expect, it } from 'vitest';

import { cronSecretFrom } from './cron';

describe('cronSecretFrom', () => {
  it.each([undefined, '', '   ', '\n'])('reads %j as unset', (value) => {
    expect(cronSecretFrom(value === undefined ? {} : { CRON_SECRET: value })).toBeNull();
  });

  it('trims a set value, the one reading every cron driver shares', () => {
    expect(cronSecretFrom({ CRON_SECRET: ' s3cret\n' })).toBe('s3cret');
  });
});
