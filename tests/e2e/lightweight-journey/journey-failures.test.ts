import { describe, expect, it, vi } from 'vitest';
import { failedRunDetail } from './journey.e2e.mjs';
import './journey-test-fixtures.js';

describe('the lightweight journey lanes (issue #832)', () => {
  describe('failedRunDetail', () => {
    const answer = (status: number, json: unknown) => ({
      request: vi.fn(() => Promise.resolve({ status, json })),
    });

    it('prints the stored status and error with every secret masked and control characters removed', async () => {
      const client = answer(200, {
        run: {
          status: 'failed',
          error: 'The runtime could not be reached.\u001b[31m e2b_test_redact_me',
        },
      });
      const detail = await failedRunDetail(client, 'run-1', ['e2b_test_redact_me']);
      expect(detail).toBe('status=failed error=The runtime could not be reached. [31m [redacted]');
      expect(client.request).toHaveBeenCalledWith('/api/runs/run-1', {});
    });

    it('authenticates as the visitor when given their token', async () => {
      const client = answer(200, { run: { status: 'failed', error: null } });
      await failedRunDetail(client, 'run-1', [], 'visitor-token');
      expect(client.request).toHaveBeenCalledWith('/api/runs/run-1', { apiKey: 'visitor-token' });
    });

    it('reports the HTTP status when the run cannot be read, and caps the length', async () => {
      expect(await failedRunDetail(answer(403, null), 'run-1', [])).toBe('status=403');
      const long = await failedRunDetail(
        answer(200, { run: { status: 'failed', error: 'x'.repeat(1_000) } }),
        'run-1',
        [],
      );
      expect(long).toHaveLength(300);
    });

    it('degrades to a fixed note when the run cannot be fetched', async () => {
      const client = { request: vi.fn(() => Promise.reject(new Error('fetch failed'))) };
      expect(await failedRunDetail(client, 'run-1', [])).toBe('run detail unavailable');
    });
  });
});
