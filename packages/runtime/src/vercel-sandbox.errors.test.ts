import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeRefusalError } from './external/errors.js';
import {
  TOKEN,
  servers,
  fakeVercel,
  driverFor,
  spec,
  config,
} from './vercel-sandbox.test-support.js';

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe('vercel credentials and provider errors', () => {
  it('surfaces the provider error code and a short reason in the failure', async () => {
    const { apiBase } = await fakeVercel(() => ({
      status: 400,
      body: { error: { code: 'bad_request', message: 'networkPolicy.mode must be\n  allow-all' } },
    }));
    await expect(driverFor(apiBase).create(config(spec()), TOKEN)).rejects.toThrow(
      'vercel-sandbox runtime: provider vercel create failed with status 400 (code bad_request: networkPolicy.mode must be allow-all).',
    );
  });

  it('keeps only the status when the error body is not usable, and drops an unsafe code', async () => {
    const plain = await fakeVercel(() => ({ status: 502, body: 'upstream' }));
    await expect(driverFor(plain.apiBase).create(config(spec()), TOKEN)).rejects.toThrow(
      'vercel-sandbox runtime: provider vercel create failed with status 502.',
    );

    const huge = await fakeVercel(() => ({
      status: 500,
      body: { error: { code: 'x', message: 'y'.repeat(10_000) } },
    }));
    await expect(driverFor(huge.apiBase).create(config(spec()), TOKEN)).rejects.toThrow(
      'vercel-sandbox runtime: provider vercel create failed with status 500.',
    );

    const unsafe = await fakeVercel(() => ({
      status: 403,
      body: { error: { code: 'forbidden: see https://x', message: 'denied' } },
    }));
    await expect(driverFor(unsafe.apiBase).create(config(spec()), TOKEN)).rejects.toThrow(
      'vercel-sandbox runtime: provider vercel create failed with status 403 (denied).',
    );
  });

  it('LC6: needs the credential on create and destroy, and keeps the sandbox addressable without it', async () => {
    const { apiBase, calls } = await fakeVercel();
    const driver = driverFor(apiBase);
    const missing: unknown = await driver.create(config(spec())).catch((caught: unknown) => caught);
    expect((missing as RuntimeRefusalError).code).toBe('provider_credential_required');
    expect(calls).toHaveLength(0);

    const handle = await driver.create(config(spec()), TOKEN);
    const noToken: unknown = await driver.destroy(handle).catch((caught: unknown) => caught);
    expect((noToken as RuntimeRefusalError).code).toBe('provider_credential_required');
    expect(await driver.isLive(handle)).toBe(true);
  });

  it('LC6: the token never appears in an error, a stack or stderr, even when the provider echoes it', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    // A bare base64url secret, like the runner bearer, with no `Bearer` prefix to anchor on.
    const secret = 'Abc_def-GHI0123456789xyz_LONGRUNNERBEARER';
    try {
      const { apiBase } = await fakeVercel((call) => ({
        status: 401,
        body: {
          error: {
            code: 'forbidden',
            message: `bad token ${String(call.authorization)} env ${secret}`,
          },
        },
      }));
      const error: unknown = await driverFor(apiBase)
        .create(config(spec()), TOKEN)
        .catch((caught: unknown) => caught);
      expect((error as Error).message).toBe(
        'vercel-sandbox runtime: provider vercel create failed with status 401 (code forbidden: bad token Bearer [redacted] env [redacted]).',
      );
      for (const leaked of [TOKEN, secret]) {
        expect((error as Error).message).not.toContain(leaked);
        expect(JSON.stringify(error)).not.toContain(leaked);
        expect(String((error as Error).stack)).not.toContain(leaked);
      }

      const unreachable: unknown = await driverFor('http://127.0.0.1:1')
        .create(config(spec()), TOKEN)
        .catch((caught: unknown) => caught);
      expect((unreachable as Error).message).toBe(
        'vercel-sandbox runtime: provider vercel create failed.',
      );
      expect(String((unreachable as Error).stack)).not.toContain(TOKEN);
      expect(JSON.stringify(write.mock.calls)).not.toContain(TOKEN);
      expect(JSON.stringify(write.mock.calls)).not.toContain(secret);
    } finally {
      write.mockRestore();
    }
  });
});
