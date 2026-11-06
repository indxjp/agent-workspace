import { describe, expect, it, vi } from 'vitest';
import { withVercelLogs } from './journey.e2e.mjs';
import './journey-test-fixtures.js';

describe('the lightweight journey lanes (issue #832)', () => {
  describe('withVercelLogs', () => {
    it('appends each deployment’s log excerpt to the failure and keeps the cause', () => {
      const run = vi.fn((_command: string, args: string[]) => ({
        stdout: `[runs] run preparation failed at the tools step (Error): ${args[1]}`,
      }));
      const cause = new Error(
        'run 99b7f1e5: run_preparation_failed: ... at the tools step (Error).',
      );
      const wrapped = withVercelLogs(cause, {
        targets: [
          ['control plane', 'https://cp.vercel.app'],
          ['manager', 'https://cp-manager.vercel.app'],
        ],
        team: 'team_x',
        token: 'vcp_token',
        run,
      });
      expect(wrapped.cause).toBe(cause);
      expect(wrapped.message).toBe(
        `${cause.message} — control plane log: [runs] run preparation failed at the tools step (Error): https://cp.vercel.app — manager log: [runs] run preparation failed at the tools step (Error): https://cp-manager.vercel.app`,
      );
    });
  });
});
