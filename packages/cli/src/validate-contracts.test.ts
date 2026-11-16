import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { describe, expect, it, vi } from 'vitest';

import { runValidateCommand } from './validate.js';

import { localProfile, projectWith, recordingProbes } from './validate.test-support.ts';

const okProbes = () => recordingProbes().probes;

const responding =
  (headers: Record<string, string>): typeof fetch =>
  () =>
    Promise.resolve(new Response(null, { status: 401, headers }));
describe('server contract compatibility', () => {
  it('refuses a server outside the supported range, naming both versions and the fix', async () => {
    const directory = await projectWith(localProfile);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const fetch = responding({
      'x-agent-workspace-contracts': '99.1.0',
      'x-agent-workspace-contracts-minimum': '99.0.0',
    });

    await expect(
      runValidateCommand([directory], {
        probes: okProbes(),
        environment: { AGENT_WORKSPACE_URL: 'https://aw.example' },
        fetch,
      }),
    ).rejects.toThrow(
      new RegExp(
        `contracts ${CONTRACTS_VERSION.replaceAll('.', '\\.')}.*99\\.0\\.0 to 99\\.1\\.0.*@indx-workspace/cli@99\\.1`,
        'u',
      ),
    );
  });

  it('passes a server in range, and asks nothing when no URL is known', async () => {
    const directory = await projectWith(localProfile);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const fetch = vi.fn(
      responding({
        'x-agent-workspace-contracts': CONTRACTS_VERSION,
        'x-agent-workspace-contracts-minimum': CONTRACTS_VERSION,
      }),
    );

    await runValidateCommand([directory], {
      probes: okProbes(),
      environment: { AGENT_WORKSPACE_URL: 'https://aw.example' },
      fetch,
    });
    await runValidateCommand([directory], { probes: okProbes(), environment: {}, fetch });

    expect(fetch).toHaveBeenCalledOnce();
    expect(err).not.toHaveBeenCalled();
  });
});

describe('contract probe availability', () => {
  it('warns and passes when the server is unreachable', async () => {
    const directory = await projectWith(localProfile);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const fetch = (() => Promise.reject(new TypeError('fetch failed'))) as typeof globalThis.fetch;

    await runValidateCommand([directory], {
      probes: okProbes(),
      environment: { AGENT_WORKSPACE_URL: 'https://aw.example' },
      fetch,
    });

    expect(err).toHaveBeenCalledWith(expect.stringContaining('could not check'));
  });

  it('bounds the contracts probe by the same timeoutMs as the store probes', async () => {
    const directory = await projectWith(localProfile);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // A server that never answers: only the abort signal ends the request.
    const fetch = ((_url: URL, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation timed out.', 'TimeoutError'));
        });
      })) as typeof globalThis.fetch;

    const started = Date.now();
    await runValidateCommand([directory], {
      probes: okProbes(),
      environment: { AGENT_WORKSPACE_URL: 'https://aw.example' },
      fetch,
      timeoutMs: 50,
    });

    expect(Date.now() - started).toBeLessThan(4000);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('(TimeoutError)'));
  });
});
