import { describe, expect, it } from 'vitest';

import { collectSecrets, redact } from './redact.js';

describe('redact', () => {
  it('masks the userinfo of every URL, including a password holding an @', () => {
    expect(redact('connect postgres://admin:p@ss@db.example:5432/aw failed', [])).toBe(
      'connect postgres://***@db.example:5432/aw failed',
    );
    expect(redact('the server at https://ops:urlpass@aw.example serves', [])).toBe(
      'the server at https://***@aw.example serves',
    );
  });

  it('masks the userinfo of a URL glued to a preceding word character', () => {
    // Found by the redaction property (F-21): a `\b` before the scheme let `_postgres://` through
    // unmasked, and masking a neighbouring secret then exposed it to a second pass.
    expect(redact('DSN=x_postgres://admin:hunter2@db/aw', [])).toBe('DSN=x_postgres://***@db/aw');
  });

  it('leaves a URL without userinfo, and an email address, alone', () => {
    const text = 'https://aw.example/api/me answered for admin@localhost.test';
    expect(redact(text, [])).toBe(text);
  });

  it('masks every literal secret, longest first', () => {
    expect(redact('tok-ABC and tok-ABCDEF', ['tok-ABCDEF', 'tok-ABC'])).toBe('*** and ***');
  });
});

describe('collectSecrets', () => {
  it('collects credential-named values and URL passwords, but not key ids', () => {
    const secrets = collectSecrets(
      {
        BOOTSTRAP_ADMIN_PASSWORD: 'pw-XYZ',
        GATEWAY_TOKEN_SECRET: 'tok-ABC',
        MASTER_ENCRYPTION_KEY: 'k'.repeat(64),
        OBJECT_STORAGE_ACCESS_KEY_ID: 'agent_workspace',
        DATABASE_URL: 'postgres://u:db%40pass@h/x',
        SESSION_SECRET: 'abc',
        PATH: '/usr/bin',
        UNSET: undefined,
      },
      'storage:\n  relational: postgres://admin:S3cretPw@db.example/aw\n',
    );

    expect(secrets).toEqual(
      expect.arrayContaining([
        'pw-XYZ',
        'tok-ABC',
        'k'.repeat(64),
        'db%40pass',
        'db@pass',
        'S3cretPw',
      ]),
    );
    expect(secrets).not.toContain('agent_workspace');
    expect(secrets).not.toContain('/usr/bin');
    // Too short to be a credential, and too likely to occur in ordinary text.
    expect(secrets).not.toContain('abc');
  });
});
