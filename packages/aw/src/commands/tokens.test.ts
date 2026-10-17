import { MintTokenResponseSchema } from '@indx-workspace/contracts/tokens';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { json, runCli, stdoutJson } from '../testing.js';

/** `TokenScopeSchema.id` is a `UuidSchema`, so a scope id on the wire is a real UUID. */
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

const MINTED = {
  token: `awt_live_${'a'.repeat(22)}_${'b'.repeat(43)}`,
  scope: { kind: 'run', id: RUN_ID },
  expiresAt: '2026-01-01T00:05:00.000Z',
  warning: 'shown once',
};

describe('aw tokens mint', () => {
  it('mints a run-scoped token and prints it as a record', async () => {
    const run = await runCli(['tokens', 'mint', '--scope', 'run', '--id', RUN_ID], {
      route: (request) => {
        expect(request.method).toBe('POST');
        expect(request.url.pathname).toBe('/api/tokens');
        expect(request.json).toEqual({ scope: { kind: 'run', id: RUN_ID } });
        return json(201, MINTED);
      },
    });

    expect(run.code).toBe(EXIT_CODE.ok);
    expect(run.stdout).toContain(MINTED.token);
    expect(run.stdout).toContain(RUN_ID);
  });

  it('sends ttlSeconds when --ttl is given', async () => {
    const run = await runCli(
      ['tokens', 'mint', '--scope', 'session', '--id', SESSION_ID, '--ttl', '600'],
      {
        route: (request) => {
          expect(request.json).toEqual({
            scope: { kind: 'session', id: SESSION_ID },
            ttlSeconds: 600,
          });
          return json(201, { ...MINTED, scope: { kind: 'session', id: SESSION_ID } });
        },
      },
    );
    expect(run.code).toBe(EXIT_CODE.ok);
  });

  it('round-trips the body through the contract under --json', async () => {
    const run = await runCli(['tokens', 'mint', '--scope', 'run', '--id', RUN_ID, '--json'], {
      route: () => json(201, MINTED),
    });
    expect(MintTokenResponseSchema.parse(stdoutJson(run))).toEqual(MINTED);
  });

  it('is a usage error without --scope or --id', async () => {
    const missingScope = await runCli(['tokens', 'mint', '--id', RUN_ID], {
      route: () => json(201, MINTED),
    });
    expect(missingScope.code).toBe(EXIT_CODE.usage);
    expect(missingScope.stderr).toContain('--scope');

    const missingId = await runCli(['tokens', 'mint', '--scope', 'run'], {
      route: () => json(201, MINTED),
    });
    expect(missingId.code).toBe(EXIT_CODE.usage);
    expect(missingId.stderr).toContain('--id');
  });

  it('rejects a --scope that is not run or session', async () => {
    const run = await runCli(['tokens', 'mint', '--scope', 'workspace', '--id', 'x'], {
      route: () => json(201, MINTED),
    });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('--scope');
  });

  it('exits 1 on a Viewer’s 403 forbidden', async () => {
    const run = await runCli(['tokens', 'mint', '--scope', 'run', '--id', RUN_ID], {
      route: () => json(403, { error: { code: 'forbidden', detail: 'the role has no grant.' } }),
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stderr).toContain('forbidden');
  });

  it('exits 3 when the body drifts from the contract', async () => {
    const run = await runCli(['tokens', 'mint', '--scope', 'run', '--id', RUN_ID], {
      route: () => json(201, { ...MINTED, token: 'not-a-token' }),
    });
    expect(run.code).toBe(EXIT_CODE.contract);
  });
});
