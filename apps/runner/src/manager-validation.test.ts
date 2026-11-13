import { expect, it, vi } from 'vitest';
import {
  withManager,
  allocationBody,
  authenticated,
  allocate,
} from './manager.fixture.test-support.js';

it('runner manager Docker lifecycle > refuses caller-controlled path segments and non-Docker profiles', async () => {
  await withManager(async (base) => {
    const escaped = await fetch(`${base}/runtimes`, {
      method: 'POST',
      headers: authenticated,
      body: JSON.stringify({ ...allocationBody, workspaceId: '../outside' }),
    });
    expect(escaped.status).toBe(400);
    const local = await fetch(`${base}/runtimes`, {
      method: 'POST',
      headers: authenticated,
      body: JSON.stringify({
        ...allocationBody,
        runSpec: { ...allocationBody.runSpec, driver: 'local' },
      }),
    });
    expect(local.status).toBe(400);
  });
});

it.each([
  ['workspaceId', { workspaceId: '../outside' }, 'invalid_workspace_id'],
  ['sessionId', { sessionId: 'a/b' }, 'invalid_session_id'],
  ['an empty engine', { engine: '' }, 'invalid_engine'],
  ['a missing engine', { engine: undefined }, 'invalid_engine'],
  ['an invalid runSpec', { runSpec: { driver: 'docker' } }, 'invalid_run_spec'],
  [
    'a driver other than the expected one',
    { runSpec: { ...allocationBody.runSpec, driver: 'local' } },
    'invalid_run_spec',
  ],
])(
  'runner manager Docker lifecycle > answers 400 %s with a typed code on /runtimes and /verify',
  async (_label, fields, code) => {
    await withManager(async (base, fixture) => {
      for (const path of ['/runtimes', '/verify']) {
        const response = await fetch(`${base}${path}`, {
          method: 'POST',
          headers: authenticated,
          body: JSON.stringify({ ...allocationBody, ...fields }),
        });
        expect(response.status).toBe(400);
        const answer = (await response.json()) as { error: string; message: string };
        expect(answer.error).toBe(code);
        expect(answer.message).not.toBe('');
      }
      expect(fixture.create).not.toHaveBeenCalled();
    });
  },
);

it('runner manager Docker lifecycle > answers 400 invalid_body for a body that is not a JSON object', async () => {
  await withManager(async (base) => {
    for (const body of ['not json', '[]']) {
      const response = await fetch(`${base}/verify`, {
        method: 'POST',
        headers: authenticated,
        body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid_body' });
    }
  });
});

it('runner manager Docker lifecycle > answers 400 invalid_tool_sandbox for an invalid toolSandbox', async () => {
  await withManager(async (base, fixture) => {
    const response = await fetch(`${base}/runtimes`, {
      method: 'POST',
      headers: authenticated,
      body: JSON.stringify({ ...allocationBody, toolSandbox: {} }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_tool_sandbox' });
    expect(fixture.create).not.toHaveBeenCalled();
  });
});

it('runner manager Docker lifecycle > answers 400 request_too_large for a /verify body over its limit', async () => {
  await withManager(async (base, fixture) => {
    // /verify reads at most 2 MiB (MAX_BODY_BYTES in manager.ts).
    const response = await fetch(`${base}/verify`, {
      method: 'POST',
      headers: authenticated,
      body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024 + 1) }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'request_too_large' });
    expect(fixture.create).not.toHaveBeenCalled();
  });
});

it('runner manager Docker lifecycle > does not expose driver failures as client validation errors', async () => {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await withManager(async (base, fixture) => {
      fixture.create.mockRejectedValueOnce(new Error('sentinel registry credential leaked'));
      const response = await allocate(base);

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'internal_error' });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('sentinel registry credential leaked'),
      );
    });
  } finally {
    stderr.mockRestore();
  }
});

it.each([
  ['a string CPU value', { cpu: '2' }],
  ['an unknown network policy', { networkPolicy: 'allowlist' }],
  ['a non-string allowed domain', { allowedDomains: ['example.com', 3] }],
  ['an unknown filesystem mode', { filesystem: 'writable' }],
  ['a non-positive timeout', { timeoutSeconds: 0 }],
  ['fractional memory', { memoryMb: 0.5 }],
  ['fractional disk', { diskMb: 12.5 }],
  ['a fractional timeout', { idleTimeoutSeconds: 1.5 }],
  ['an unknown field', { unexpected: true }],
])(
  'runner manager Docker lifecycle > refuses runtime specifications with %s',
  async (_label, invalidFields) => {
    await withManager(async (base, fixture) => {
      const response = await fetch(`${base}/runtimes`, {
        method: 'POST',
        headers: authenticated,
        body: JSON.stringify({
          ...allocationBody,
          runSpec: { ...allocationBody.runSpec, ...invalidFields },
        }),
      });

      expect(response.status).toBe(400);
      expect(fixture.create).not.toHaveBeenCalled();
    });
  },
);
