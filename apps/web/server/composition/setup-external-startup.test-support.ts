import { describe, expect, it, vi } from 'vitest';
import { createRuntimeManagerClient } from '../compose/runtime-manager-client';
import { configureWebRuntimeRegistry } from '../runtimes/registry';
import { log as webLogger } from '../telemetry/logger';
import { EXTERNAL, runtimeConnectionNames } from './setup-external-fixture.test-support';
import {
  complete,
  db,
  E2B_KEY,
  expectUntouched,
  LOCAL_REGISTRY,
  scope,
  setupInput,
  withFailingRoot,
} from './setup-fixture.test-support';

export function registerExternalStartupTests(): void {
  describe('a manager Worker whose container is still starting', () => {
    const starting = () => new Response('The runner manager is starting', { status: 503 });
    const verified = () =>
      Response.json({
        fingerprint: 'verified-fingerprint',
        verifiedAt: '2026-09-11T00:00:00.000Z',
        expiresAt: '2026-09-12T00:00:00.000Z',
      });

    /** The real client over a manager that answers `answers` in order, then repeats the last. */
    function useManager(answers: readonly (() => Response)[]): { calls: () => number } {
      let calls = 0;
      configureWebRuntimeRegistry({
        ...LOCAL_REGISTRY,
        list: () =>
          LOCAL_REGISTRY.list().then((entries) =>
            entries.map((entry) => ({ ...entry, id: 'external' })),
          ),
        test: async (driverId) => {
          const client = createRuntimeManagerClient(
            'https://manager.example',
            'm'.repeat(32),
            () => {
              const answer = answers[Math.min(calls, answers.length - 1)];
              calls += 1;
              if (answer === undefined) throw new Error('no manager answer');
              return Promise.resolve(answer());
            },
            { notReadyRetry: { windowMs: 200, initialDelayMs: 5 } },
          );
          await client.verify(
            { sessionId: 's', workspacePath: '/workspace', engine: 'claude-agent-sdk' },
            'external',
            E2B_KEY,
          );
          return { driverId, transcript: [], destroyed: true };
        },
      });
      return { calls: () => calls };
    }

    it('completes setup once the manager answers the retried runtime test', async () => {
      const manager = useManager([starting, starting, verified]);
      const result = await complete(setupInput(EXTERNAL));
      expect(result.ok).toBe(true);
      expect(manager.calls()).toBe(3);
    });

    it('fails setup at the runtime test step with the typed hop, and stores nothing, when it never starts', async () => {
      vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
      const manager = useManager([starting]);
      const refused = await complete(setupInput(EXTERNAL));
      expect(refused).toMatchObject({ ok: false, status: 500, code: 'setup_failed' });
      if (refused.ok) throw new Error('unreachable');
      expect(refused.message).toBe(
        'Setup failed at the runtime test step (RuntimeManagerError: runner manager answered HTTP 503 manager_not_ready). See the server log, then retry.',
      );
      expect(manager.calls()).toBeGreaterThan(1);
      await expectUntouched();
    });
  });

  describe('a runtime that refuses every network policy (ADR-0131)', () => {
    const CLOUDFLARE = { ...EXTERNAL, runtime: 'cloudflare-sandbox' };

    /** The manager's answer for `cloudflare-sandbox`: every policy refused by name. */
    function useRefusingRegistry(): void {
      configureWebRuntimeRegistry({
        ...LOCAL_REGISTRY,
        list: () =>
          LOCAL_REGISTRY.list().then((entries) =>
            entries.map((entry) => ({ ...entry, id: 'cloudflare-sandbox' })),
          ),
        test: async () => {
          const client = createRuntimeManagerClient('https://manager.example', 'm'.repeat(32), () =>
            Promise.resolve(
              Response.json(
                {
                  error: 'network_policy_unsupported',
                  message: 'external runtime: provider cloudflare-sandbox refuses the none',
                },
                { status: 422 },
              ),
            ),
          );
          await client.verify(
            { sessionId: 's', workspacePath: '/workspace', engine: 'claude-agent-sdk' },
            'cloudflare-sandbox',
            E2B_KEY,
          );
          throw new Error('unreachable');
        },
      });
    }

    it('completes setup and records the refusal instead of failing', async () => {
      useRefusingRegistry();
      const result = await complete(setupInput(CLOUDFLARE));
      if (!result.ok) throw new Error(`setup refused: ${result.code}`);
      expect(result.runtimeRefusal).toEqual({
        code: 'network_policy_unsupported',
        message:
          'cloudflare-sandbox refuses every network policy (ADR-0131): runs are refused with network_policy_unsupported until a policy is declared.',
      });
      const profile = await db().runtimeProfiles.forScope(scope()).get(result.runtimeProfileId);
      expect(profile).toMatchObject({ driver: 'cloudflare-sandbox' });
      expect(JSON.stringify(result)).not.toContain(E2B_KEY);
    });

    it('still rolls everything back when a write throws after the refusal', async () => {
      vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
      useRefusingRegistry();
      await withFailingRoot(
        { setWorkspaceSetupAgentId: () => Promise.reject(new Error('connection terminated')) },
        async () => {
          expect(await complete(setupInput(CLOUDFLARE))).toMatchObject({
            ok: false,
            status: 500,
            code: 'setup_failed',
          });
        },
      );
      await expectUntouched();
      expect(await runtimeConnectionNames()).toEqual([]);
    });
  });
}
