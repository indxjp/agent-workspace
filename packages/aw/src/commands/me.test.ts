import { MeResponseSchema } from '@indx-workspace/contracts/team';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { json, runCli, stdoutJson } from '../testing.js';

const PRINCIPAL = {
  principalId: '77777777-7777-4777-8777-777777777777',
  kind: 'api-key',
  role: 'builder',
  workspaceId: '44444444-4444-4444-8444-444444444444',
  userId: null,
  label: 'ci',
  features: ['chat', 'runs'],
};

describe('aw me', () => {
  it('prints the principal as a record, in the contract’s field order', async () => {
    const run = await runCli(['me'], { route: () => json(200, PRINCIPAL) });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.calls[0]?.method).toBe('GET');
    expect(run.calls[0]?.url.pathname).toBe('/api/me');
    // `renderRecord` prints one `field  value` line per key, in the order the body carries them,
    // which is the order the contract declares.
    expect(run.stdout.split('\n').map((line) => line.split(/\s{2,}/u)[0])).toEqual([
      'principalId',
      'kind',
      'role',
      'workspaceId',
      'userId',
      'label',
      'features',
      '',
    ]);
    expect(run.stdout).toContain('ci');
    expect(run.stdout).toContain('builder');
  });

  it('round-trips the body through the contract under --json', async () => {
    const run = await runCli(['me', '--json'], { route: () => json(200, PRINCIPAL) });

    expect(MeResponseSchema.parse(stdoutJson(run))).toEqual(PRINCIPAL);
  });

  it('exits 1 on a 401, which is what a revoked key and an expired session both answer', async () => {
    const run = await runCli(['me'], {
      route: () =>
        json(401, {
          error: { code: 'unauthenticated', detail: 'This route requires a credential.' },
        }),
    });

    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('unauthenticated');
  });

  it('exits 3 when the body is not the principal the contract describes', async () => {
    const run = await runCli(['me'], {
      route: () => json(200, { ...PRINCIPAL, apiKeyId: 'k-1' }),
    });

    expect(run.code).toBe(EXIT_CODE.contract);
  });
});
