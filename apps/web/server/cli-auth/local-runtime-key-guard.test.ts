/**
 * S1-21 (issue #500): the reserved-name half of `local-runtime-key-guard.ts`. The principal half is
 * proven against PostgreSQL and the real routes in `local-credential.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { LOCAL_RUNTIME_API_KEY_NAME_PREFIX } from './local-credential';
import { reservedKeyNameRefusal } from './local-runtime-key-guard';

describe('reservedKeyNameRefusal', () => {
  it.each([
    `${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}AAAAAAAA`,
    `  ${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}mine`,
    LOCAL_RUNTIME_API_KEY_NAME_PREFIX.trimEnd(),
  ])('refuses %j with 400 reserved_name', (name) => {
    const refusal = reservedKeyNameRefusal({ name, role: 'viewer' });
    expect(refusal?.status).toBe(400);
    expect(refusal?.body).toMatchObject({ error: { code: 'reserved_name' } });
  });

  it.each([
    { name: 'ci deploy key' },
    { name: 'my aw dev local runtime' },
    { name: 42 },
    {},
    null,
    'aw dev local runtime x',
  ])('leaves %j to the handler', (body) => {
    expect(reservedKeyNameRefusal(body)).toBeNull();
  });
});
