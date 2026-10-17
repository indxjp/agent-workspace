import { SecretResourceSchema } from '@indx-workspace/contracts/secrets';
import { describe, expect, it } from 'vitest';

import { EXIT_CODE } from '../output.js';
import { FIXTURES, json, runCli, stdoutJson } from '../testing.js';

describe('aw secrets', () => {
  it('lists metadata only', async () => {
    const run = await runCli(['secrets', 'list', '--json'], {
      route: () => json(200, { secrets: [FIXTURES.secret] }),
    });
    expect(SecretResourceSchema.array().parse(stdoutJson(run))).toEqual([FIXTURES.secret]);
  });

  it('creates with --name and the value from stdin, and refuses a value nowhere', async () => {
    const create = await runCli(['secrets', 'create', '--name', 'GITHUB_TOKEN', '--value-stdin'], {
      stdin: 'ghp_x\n',
      route: () => json(201, FIXTURES.secret),
    });
    expect(create.code).toBe(EXIT_CODE.ok);
    expect(create.calls[0]?.json).toEqual({ name: 'GITHUB_TOKEN', value: 'ghp_x' });
    expect(create.stdout).toContain('GITHUB_TOKEN');

    const missing = await runCli(['secrets', 'create', '--name', 'GITHUB_TOKEN']);
    expect(missing.code).toBe(EXIT_CODE.usage);
    expect(missing.stderr).toContain('value');
    expect(missing.calls).toHaveLength(0);

    const empty = await runCli(['secrets', 'create', '--name', 'GITHUB_TOKEN', '--value-stdin'], {
      stdin: '\n',
    });
    expect(empty.code).toBe(EXIT_CODE.usage);
    expect(empty.stderr).toContain('empty');
  });

  it('replaces from stdin', async () => {
    const run = await runCli(['secrets', 'replace', 's-1', '--value-stdin', '--json'], {
      stdin: 'ghp_y',
      route: () => json(200, FIXTURES.secret),
    });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]?.method).toBe('PUT');
    expect(run.calls[0]?.json).toEqual({ value: 'ghp_y' });
    expect(SecretResourceSchema.parse(stdoutJson(run))).toEqual(FIXTURES.secret);
  });

  it('replaces by name through the list route, and names the create command for an unknown one', async () => {
    const run = await runCli(['secrets', 'replace', 'GITHUB_TOKEN', '--value-stdin'], {
      stdin: 'ghp_z',
      route: (request) =>
        request.method === 'GET'
          ? json(200, { secrets: [FIXTURES.secret] })
          : json(200, FIXTURES.secret),
    });
    expect(run.code).toBe(EXIT_CODE.ok);
    expect(
      run.calls.map((call) => `${call.method} ${call.url.pathname}${call.url.search}`),
    ).toEqual(['GET /api/secrets?name=GITHUB_TOKEN', 'PUT /api/secrets/s-1']);
    expect(run.calls[1]?.json).toEqual({ value: 'ghp_z' });

    const unknown = await runCli(['secrets', 'replace', 'OTHER_KEY', '--value-stdin'], {
      stdin: 'x',
      route: () => json(404, { error: { code: 'secret_not_found', message: 'No such secret.' } }),
    });
    expect(unknown.code).toBe(EXIT_CODE.problem);
    expect(unknown.stderr).toContain('aw secrets create --name OTHER_KEY --value-stdin');
    expect(unknown.calls).toHaveLength(1);
  });

  it('removes by name, and refuses an unknown name (BH061-066)', async () => {
    const removed = await runCli(['secrets', 'remove', 'GITHUB_TOKEN'], {
      route: (request) =>
        request.method === 'GET'
          ? json(200, { secrets: [FIXTURES.secret] })
          : new Response(null, { status: 204 }),
    });
    expect(removed.code).toBe(EXIT_CODE.ok);
    expect(removed.calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      'GET /api/secrets',
      `DELETE /api/secrets/${FIXTURES.secret.id}`,
    ]);
    const unknown = await runCli(['secrets', 'remove', 'OTHER_KEY'], {
      route: () => json(200, { secrets: [FIXTURES.secret] }),
    });
    expect(unknown.code).toBe(EXIT_CODE.problem);
    expect(unknown.stderr).toContain('no secret named OTHER_KEY');
    expect(unknown.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });

  it('refuses a reserved name before any request (BH061-066)', async () => {
    const run = await runCli(['secrets', 'create', '--name', 'PORT', '--value-stdin'], {
      stdin: 'x',
    });
    expect(run.code).toBe(EXIT_CODE.usage);
    expect(run.stderr).toContain('PORT is reserved');
    expect(run.calls).toHaveLength(0);
  });

  it('removes by id and reports secret_in_use as an API failure', async () => {
    const removed = await runCli(['secrets', 'remove', 's-1'], {
      route: () => new Response(null, { status: 204 }),
    });
    expect(removed.code).toBe(EXIT_CODE.ok);
    expect(removed.calls[0]?.method).toBe('DELETE');
    expect(removed.calls[0]?.url.pathname).toBe('/api/secrets/s-1');

    const inUse = await runCli(['secrets', 'remove', 's-1'], {
      route: () =>
        json(409, {
          error: { code: 'secret_in_use', message: 'Referenced.', details: ['connector:c-1'] },
        }),
    });
    expect(inUse.code).not.toBe(EXIT_CODE.ok);
    expect(inUse.stderr).toContain('secret_in_use');
  });
});
