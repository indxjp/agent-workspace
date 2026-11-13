import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearEnginesRegisteredForTests,
  registerEngineForTests,
  registeredEngine,
} from '../engines/registry';
import { dryRunOf, FIXTURE_POLICY, versionRequest } from './fixtures';
import type { SeededReferences } from './memory-store';
import {
  agent,
  expectRefusal,
  refusalOf,
  storeWith,
  storeWithAgents,
  validate,
  validateVersionRequest,
} from './pipeline.test-support';
import type { WorkspaceAgentVersionStore } from './store';

afterEach(() => {
  clearEnginesRegisteredForTests();
});

describe('validateAgentVersion', () => {
  describe('5. engine capability', () => {
    it('answers 422 engine_capability_unsupported ["mcp"] for a connector on pi', async () => {
      expect(registeredEngine('pi')?.capabilities.mcp).toBe(false);
      expectRefusal(
        await validate(
          versionRequest({
            policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
            resources: { connectors: ['crm'] },
          }),
          { references: { connector: [{ id: 'c1', name: 'crm' }] } },
        ),
        422,
        'engine_capability_unsupported',
        ['mcp'],
      );
    });

    // S2-02f (#531): a tool connector reaches the engine as a gateway MCP server, so it demands
    // `mcp` like any connector; the demand never depends on the connector's kind.
    it('answers 422 engine_capability_unsupported ["mcp"] at dry run for a tool connector on pi', async () => {
      expectRefusal(
        await validate(
          {
            ...versionRequest({
              policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
              resources: { connectors: ['orders'] },
            }),
            dryRun: true,
          },
          { references: { connector: [{ id: 'openapi-orders', name: 'orders' }] } },
        ),
        422,
        'engine_capability_unsupported',
        ['mcp'],
      );
    });

    // ADR-0133 D14: pi does not delegate, so a body naming a subagent is refused on save and on dry
    // run alike, and a body without one is unchanged.
    it.each([false, true])(
      'answers 422 engine_capability_unsupported ["subagents"] for a subagent on pi (dryRun %s)',
      async (dryRun) => {
        const pi = {
          engine: 'pi',
          skills: { mode: 'all' },
          limits: FIXTURE_POLICY.limits,
        } as const;
        const base = dryRun
          ? dryRunOf(versionRequest({ policy: pi }))
          : versionRequest({ policy: pi });
        expectRefusal(
          await validate(
            { ...base, body: { ...base.body, subagents: [{ name: 'Researcher' }] } },
            { store: await storeWithAgents([{ name: 'Researcher' }]) },
          ),
          422,
          'engine_capability_unsupported',
          ['subagents'],
        );
      },
    );

    it('saves a body with no subagents without asking for agents', async () => {
      const base = versionRequest();
      const store = await storeWith();
      const agentsByName = vi.fn<WorkspaceAgentVersionStore['agentsByName']>();
      expect(
        (
          await validate(
            { ...base, body: { ...base.body, subagents: [] } },
            { store: { ...store, agentsByName } },
          )
        ).ok,
      ).toBe(true);
      expect(agentsByName).not.toHaveBeenCalled();
    });

    it('treats a compiled policy as demanding every assigned skill', async () => {
      registerEngineForTests({
        id: 'claude-agent-sdk',
        displayName: 'Claude Agent SDK (test: no skills)',
        version: 'test',
        capabilities: {
          mcp: true,
          skills: false,
          subagents: false,
          resume: true,
          fork: false,
          interrupt: true,
          streamingText: false,
          reasoning: true,
          maxTurns: 'native',
          maxBudget: 'native',
          wireProtocols: ['anthropic-messages'],
        },
      });
      const references: SeededReferences = { skill: [{ id: 's1', name: 'triage' }] };
      const allowlistNone = versionRequest({
        policy: { ...FIXTURE_POLICY, skills: { mode: 'allowlist', names: [] } },
        resources: { skills: ['triage'] },
      });
      expect((await validate(allowlistNone, { references })).ok).toBe(true);
      const compiled = versionRequest({
        policy: { ...FIXTURE_POLICY, skills: { mode: 'allowlist', names: [] } },
        policySource: 'compiled',
        resources: { skills: ['triage'] },
      });
      expect(refusalOf(await validate(compiled, { references })).body).toMatchObject({
        error: { code: 'engine_capability_unsupported', details: ['skills'] },
      });
    });
  });

  describe('6. engine switch', () => {
    const storedClaude = agent({
      policy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: ['mcp__github__*'] } },
    });

    it('answers 422 engine_switch_would_widen naming each refused rule', async () => {
      expectRefusal(
        await validate(
          versionRequest({
            policy: {
              engine: 'openai-agents',
              skills: { mode: 'all' },
              limits: FIXTURE_POLICY.limits,
            },
          }),
          { subject: storedClaude },
        ),
        422,
        'engine_switch_would_widen',
        ['mcp__github__*'],
      );
    });

    it('labels a refused rule stored by connector id with the connector name, details verbatim (#1121)', async () => {
      const finder = '00000000-0000-4000-8000-0000000000a1';
      const rule = `mcp__connector-${finder}__delete`;
      const refusal = refusalOf(
        await validate(
          versionRequest({
            policy: {
              engine: 'openai-agents',
              skills: { mode: 'all' },
              limits: FIXTURE_POLICY.limits,
            },
          }),
          {
            subject: agent({
              policy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: [rule] } },
            }),
            references: { connector: [{ id: finder, name: 'file-finder' }] },
          },
        ),
      );
      expect(refusal.body).toMatchObject({
        error: {
          code: 'engine_switch_would_widen',
          details: [rule],
          message: expect.stringContaining(`${rule} (file-finder).`) as unknown,
        },
      });
    });

    it('carries the stored narrowing into the policy a save stores', async () => {
      const result = await validate(
        versionRequest({
          policy: { engine: 'pi', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
        }),
        {
          subject: agent({
            policy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: ['Bash'] } },
          }),
        },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.policyToStore).toMatchObject({
          engine: 'pi',
          withheldPermissions: ['runCommands'],
        });
      }
    });

    it('stores nothing for a compiled policy, and does not refuse its switch', async () => {
      const result = await validate(
        versionRequest({
          policy: {
            engine: 'openai-agents',
            skills: { mode: 'all' },
            limits: FIXTURE_POLICY.limits,
          },
          policySource: 'compiled',
        }),
        { subject: storedClaude },
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.policyToStore).toBeNull();
    });

    it('carries nothing for a subject that does not exist yet', async () => {
      const result = await validateVersionRequest(
        versionRequest(),
        { kind: 'new' },
        { store: await storeWith() },
      );
      expect(result.ok && result.policyToStore).toEqual(FIXTURE_POLICY);
    });
  });
});
