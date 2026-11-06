import { describe, expect, it, vi } from 'vitest';
import { awaitSetup } from './journey.e2e.mjs';
import './journey-test-fixtures.js';

describe('the lightweight journey lanes (issue #832)', () => {
  describe('awaitSetup', () => {
    const fast = { windowMs: 250, delayMs: 5 };
    const url = 'https://cp.example.workers.dev';

    it('names the last status and the start of the body when /setup never answers 200', async () => {
      const get = vi.fn(() =>
        Promise.resolve(new Response('The control plane is starting', { status: 503 })),
      );
      await expect(awaitSetup(url, { ...fast, fetch: get })).rejects.toThrow(
        /\/setup with 200 in 0\.25 s \(\d+ requests\); last: HTTP 503 "The control plane is starting"/u,
      );
      expect(get.mock.calls.length).toBeGreaterThan(1);
    });

    it("summarizes Cloudflare's HTML error page to its title, code and cf-ray", async () => {
      const page =
        '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->' +
        '<head><title>Worker threw exception | cp.example.workers.dev | Cloudflare</title></head>' +
        '<body><span class="cf-error-code">Error 1101</span></body></html>';
      const get = () =>
        Promise.resolve(new Response(page, { status: 500, headers: { 'cf-ray': '9a1b-NRT' } }));
      const message = await awaitSetup(url, { windowMs: 0, delayMs: 0, fetch: get }).then(
        () => '',
        (error: unknown) => String(error),
      );
      expect(message).toContain('code: Error 1101');
      expect(message).toContain('cf-ray: 9a1b-NRT');
      expect(message).not.toContain('<!DOCTYPE');
    });

    it('does not count a redirect as an answer', async () => {
      const get = () =>
        Promise.resolve(new Response(null, { status: 307, headers: { location: '/signin' } }));
      await expect(awaitSetup(url, { ...fast, fetch: get })).rejects.toThrow('last: HTTP 307');
    });

    it('names the network error cause code', async () => {
      const get = () =>
        Promise.reject(
          new TypeError('fetch failed', {
            cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }),
          }),
        );
      await expect(awaitSetup(url, { ...fast, fetch: get })).rejects.toThrow(
        'last: network error ECONNREFUSED',
      );
    });

    it('gives each attempt a timeout so a hung server is reported, not waited on', async () => {
      const get = (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
        });
      await expect(
        awaitSetup(url, { windowMs: 0, delayMs: 0, requestTimeoutMs: 5, fetch: get }),
      ).rejects.toThrow('last: network error');
    });

    it('resolves as soon as /setup answers 200', async () => {
      const answers = [503, 503, 200];
      const get = vi.fn(() =>
        Promise.resolve(new Response('', { status: answers.shift() ?? 500 })),
      );
      await expect(
        awaitSetup(url, { ...fast, windowMs: 5_000, fetch: get }),
      ).resolves.toBeUndefined();
      expect(get).toHaveBeenCalledTimes(3);
    });
  });
});
