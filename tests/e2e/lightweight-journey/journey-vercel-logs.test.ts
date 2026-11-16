import { describe, expect, it, vi } from 'vitest';
import { vercelLogExcerpt } from './journey.e2e.mjs';
import './journey-test-fixtures.js';

describe('the lightweight journey lanes (issue #832)', () => {
  describe('vercelLogExcerpt', () => {
    const base = { url: 'https://cp.vercel.app', team: 'team_x', token: 'vcp_token' };

    it('keeps the last error lines of the log, runs vercel logs with the token in the child env only', () => {
      const run = vi.fn(() => ({
        stdout: [
          'GET / 200',
          'Error: AW_DEPLOYMENT_POLICY is invalid: the value is not JSON',
          'GET /setup 500',
          'Error: instrumentation failed',
        ].join('\n'),
      }));
      const excerpt = vercelLogExcerpt({ ...base, lines: 1, run });
      expect(excerpt).toBe('Error: instrumentation failed');
      const [command, args, options] = run.mock.calls[0] as unknown as [
        string,
        string[],
        { env: NodeJS.ProcessEnv; timeout: number },
      ];
      expect([command, ...args]).toEqual(['vercel', 'logs', base.url, '--scope', 'team_x']);
      expect(options.env['VERCEL_TOKEN']).toBe('vcp_token');
      expect(options.timeout).toBeGreaterThan(0);
    });

    it('keeps what arrived when the stream is killed at the timeout', () => {
      const run = () => ({
        stdout: 'Error: invalid policy',
        error: new Error('spawnSync vercel ETIMEDOUT'),
      });
      expect(vercelLogExcerpt({ ...base, run })).toBe('Error: invalid policy');
    });

    it('says why there is no excerpt instead of failing', () => {
      const run = () => ({ stdout: null, error: new Error('spawnSync vercel ENOENT') });
      expect(vercelLogExcerpt({ ...base, run })).toBe(
        '(no runtime log excerpt: spawnSync vercel ENOENT)',
      );
      expect(vercelLogExcerpt({ ...base, run: () => ({ stdout: 'GET / 200\n' }) })).toBe(
        '(no runtime log excerpt: no error lines)',
      );
    });

    it('keeps the manager’s own failure line and a provider failure', () => {
      const run = () => ({
        stdout: [
          'GET /verify 500',
          'runner manager request failed: vercel-sandbox runtime: provider vercel create failed with status 400.',
        ].join('\n'),
      });
      expect(vercelLogExcerpt({ ...base, run })).toContain(
        'runner manager request failed: vercel-sandbox runtime: provider vercel create failed with status 400.',
      );
    });
  });
});
