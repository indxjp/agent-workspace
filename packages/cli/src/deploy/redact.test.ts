import { IGNORED_STORAGE_VARIABLES } from '@indx-workspace/contracts/storage-settings';
import { describe, expect, it } from 'vitest';

import { createRedactor } from './redact.js';

describe('createRedactor', () => {
  const redact = createRedactor({
    SESSION_SECRET: 'd'.repeat(64),
    BOOTSTRAP_ADMIN_PASSWORD: 'admin-password',
    DATABASE_URL: 'postgres://aw:postgres-password@postgres:5432/aw',
    OPERATOR_TOKEN: "'quoted-token'",
    WEB_IMAGE: 'registry.example/web@sha256:1111',
    COMPOSE_PROJECT_NAME: 'acme-ai',
    AWS_REGION: 'eu-west-1',
    SHORT: 'abc',
    AW_PUBLIC_URL: 'https://agents.acme.example',
    AGENT_WORKSPACE_VERSION: '0.6.1',
  });

  it('masks every .env value that is not public configuration', () => {
    const text = redact(
      `session ${'d'.repeat(64)} password admin-password url postgres://aw:postgres-password@postgres:5432/aw token quoted-token`,
    );
    expect(text).toBe('session *** password *** url *** token ***');
  });

  it('keeps image references, the project name and public settings readable', () => {
    expect(redact('pull registry.example/web@sha256:1111 for acme-ai in eu-west-1')).toBe(
      'pull registry.example/web@sha256:1111 for acme-ai in eu-west-1',
    );
  });

  it('keeps the release version readable, so a path naming it is not masked (BH061-077)', () => {
    expect(redact('wrote ~/aw-bughunt-0.6.1/acme-ai/.env')).toBe(
      'wrote ~/aw-bughunt-0.6.1/acme-ai/.env',
    );
  });

  it('keeps the public origin readable', () => {
    expect(redact('GET https://agents.acme.example/api/health')).toBe(
      'GET https://agents.acme.example/api/health',
    );
  });

  // STO-606 (#1703): nothing generates the old storage variables any more, so a value left behind in
  // an operator's `.env` is masked like any other key `deploy` does not know to be public.
  it('masks the values of the eight ignored storage variables', () => {
    expect(IGNORED_STORAGE_VARIABLES).toHaveLength(8);
    const values = IGNORED_STORAGE_VARIABLES.map((name, index): [string, string] => [
      name,
      `old-storage-value-${String(index)}`,
    ]);
    const withOld = createRedactor(Object.fromEntries(values));
    const printed = values.map(([, value]) => value).join(' ');
    expect(withOld(printed)).toBe(values.map(() => '***').join(' '));
  });

  it('does not mask a value too short to be a credential', () => {
    expect(redact('abc')).toBe('abc');
  });

  it('masks the user information of any URL, including one only the profile holds', () => {
    expect(
      redact('dial postgres://ops:profile-pass@db.example:5432/aw and https://x.example/a'),
    ).toBe('dial postgres://***@db.example:5432/aw and https://x.example/a');
  });

  it('masks a URL password from the profile wherever it appears on its own', () => {
    const withProfile = createRedactor(
      {},
      'storage:\n  relational: postgres://ops:hunter22@db/aw\n',
    );
    expect(withProfile('auth failed for hunter22')).toBe('auth failed for ***');
  });
});
