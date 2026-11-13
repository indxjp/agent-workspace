import { journeySource } from './journey-test-fixtures.js';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectPolicySchema } from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it, vi } from 'vitest';
import { promotePastGate } from '../build-deploy-journey/journey.e2e.mjs';
import { frontendTurn, JOURNEY_DEPLOYMENT_POLICY, setDotEnv } from './journey.e2e.mjs';
import { directories } from './journey-test-fixtures.js';

describe('the lightweight journey lanes (issue #832)', () => {
  describe('the gate and the frontend turn (issue #832)', () => {
    const source = () => journeySource();

    it('gives the profile-path deployment the promotion bar aw deploy would write, single-quoted', () => {
      expect(ProjectPolicySchema.parse(JSON.parse(JOURNEY_DEPLOYMENT_POLICY))).toEqual({
        promotion: { minEvalScore: 1 },
      });
      const env = setDotEnv('A=1\n', { AW_DEPLOYMENT_POLICY: `'${JOURNEY_DEPLOYMENT_POLICY}'` });
      expect(env).toBe(`A=1\nAW_DEPLOYMENT_POLICY='${JOURNEY_DEPLOYMENT_POLICY}'\n`);
      expect(source()).toMatch(
        /lane\.deploy === 'profile'\) \{\s*entries\['AW_DEPLOYMENT_POLICY'\] = `'\$\{JOURNEY_DEPLOYMENT_POLICY\}'`;/u,
      );
    });

    it('runs the below-bar half of the gate on every lane that reaches it', () => {
      expect(source()).toMatch(/promotePastGate\(\{[^}]*refusal: true,\s*\}\);/u);
    });

    describe('promotePastGate', () => {
      const gate = (refusal: string) => {
        const project = mkdtempSync(path.join(tmpdir(), 'lj-gate-'));
        directories.push(project);
        mkdirSync(path.join(project, 'evals'));
        writeFileSync(path.join(project, 'evals/support.yaml'), 'cases: []\n');
        const calls: string[][] = [];
        const aw = (args: string[]) => {
          calls.push(args);
          const [command, subcommand] = args;
          if (command === 'versions') {
            return JSON.stringify({
              pointers: [
                { environment: 'local', number: 3 },
                { environment: 'production', number: 3 },
              ],
            });
          }
          const passed = calls.some((call) => call.includes('--junit'));
          if (command === 'eval' && subcommand === 'run')
            return passed ? '' : 'v3 is below --min-score 1';
          return command === 'promote' && !passed ? refusal : '';
        };
        vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const created = { project, aw, agentName: 'support' } as never;
        return () => promotePastGate({ created, remote: {}, evidence: project, refusal: true });
      };

      it('passes when the refusal names the version it refused', () => {
        expect(gate('production refused: v3 scored 0 (bar 1). Failing cases: x')).not.toThrow();
      });

      it('fails on a refusal that names another version or only says refused', () => {
        expect(gate('production refused: v2 scored 0 (bar 1).')).toThrow(
          /refused below the bar \(v3\)/u,
        );
        expect(gate('production refused')).toThrow(/refused below the bar \(v3\)/u);
      });
    });

    describe('frontendTurn', () => {
      const origin = 'https://web.example';
      const nonce = 'e2e-nonce-journeyabcd';
      const session = { token: 'visitor-token-1234', sessionId: 'sess-1', agentId: 'agent-1' };
      const frames = (status: string, text: string) => [
        { event: 'agent.message', data: { role: 'assistant', blocks: [{ type: 'text', text }] } },
        { event: 'run.status', data: { status } },
      ];
      type Ask = Parameters<typeof frontendTurn>[0]['ask'];
      const turn = (over: { status?: number; allow?: string | null; frames?: unknown[] } = {}) => {
        const ask = vi.fn<Ask>(() =>
          Promise.resolve({
            status: over.status ?? 202,
            text: '{}',
            headers: new Headers(
              over.allow === null ? {} : { 'access-control-allow-origin': over.allow ?? origin },
            ),
            json: { run: { id: 'run-1' } },
          }),
        );
        const lines: string[] = [];
        const report = (ok: boolean, message: string) => {
          if (!ok) throw new Error(`journey assertion failed: ${message}`);
          lines.push(message);
        };
        const framesOf = vi.fn<(runId: string) => Promise<unknown[]>>(() =>
          Promise.resolve(over.frames ?? frames('completed', `order-data-${nonce}`)),
        );
        return {
          ask,
          lines,
          framesOf,
          run: () =>
            frontendTurn({
              control: 'https://cp.example',
              origin,
              nonce,
              session,
              ask,
              framesOf,
              report,
            }),
        };
      };

      it('sends the run the way the frontend client does and accepts a completed, answered turn', async () => {
        const t = turn();
        await t.run();
        const [url, init] = t.ask.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://cp.example/api/agents/agent-1/runs');
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({ authorization: `Bearer ${session.token}`, origin });
        expect(JSON.parse(typeof init.body === 'string' ? init.body : '')).toEqual({
          prompt: `Look up order ${nonce} with your order tool and repeat the tool output exactly.`,
          sessionId: 'sess-1',
        });
        expect(t.framesOf).toHaveBeenCalledWith('run-1');
        expect(t.lines).toHaveLength(4);
        expect(t.lines.join('\n')).not.toContain(session.token);
      });

      it.each([
        ['a run that is not accepted', { status: 403 }, /was accepted \(403/u],
        ['a missing CORS header', { allow: null }, /allows the frontend origin \(null\)/u],
        ['another allowed origin', { allow: 'https://other.example' }, /allows the frontend/u],
        ['a run that did not complete', { frames: frames('failed', 'x') }, /run completed/u],
        [
          'a reply without the tool data',
          { frames: frames('completed', 'hello') },
          /carries the code tool's data/u,
        ],
      ])('fails on %s', async (_name, over, message) => {
        await expect(turn(over).run()).rejects.toThrow(message);
      });
    });
  });
});
