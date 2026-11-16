import { describe, expect, it } from 'vitest';
import type { AgentPolicy } from '../../../../../contracts/agents';
import { installTestDomains } from '../../../../../server/application-context-fixtures';
import {
  CONNECTOR_ID,
  createAsBuilderA,
  putPolicy,
  readPolicy,
  readPolicyBody,
  useMemoryRuntime,
  validPolicy,
} from './policy.test-support';

describe('PUT /api/agents/:id/policy — an engine switch carries the narrowing (ADR-0074 D12)', () => {
  const OPENAI_BODY: AgentPolicy = {
    engine: 'openai-agents',
    skills: { mode: 'allowlist', names: [] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
  };

  it("writes the Claude arm's Bash denial and plan mode into the new arm as withheld switches", async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();
    const stored = validPolicy({ skills: { mode: 'allowlist', names: [] } });
    if (stored.engine !== 'claude-agent-sdk') throw new Error('fixture');
    expect(
      (await putPolicy(agent.id, { ...stored, tools: { ...stored.tools, permissionMode: 'plan' } }))
        .status,
    ).toBe(200);

    const response = await putPolicy(agent.id, OPENAI_BODY);

    expect(response.status, await response.clone().text()).toBe(200);
    const expected = { ...OPENAI_BODY, withheldPermissions: ['writeFiles', 'runCommands'] };
    expect(await response.json()).toEqual({ policy: expected, source: 'stored' });
    expect(await readPolicy(agent.id)).toEqual(expected);
  });

  it('refuses 422 engine_switch_would_widen naming every MCP denial, and stores nothing', async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();
    const stored = validPolicy({ skills: { mode: 'allowlist', names: [] } });
    if (stored.engine !== 'claude-agent-sdk') throw new Error('fixture');
    const narrowed: AgentPolicy = {
      ...stored,
      tools: { ...stored.tools, deny: ['Bash', 'mcp__github__delete_repo', 'mcp__jira__*'] },
    };
    expect((await putPolicy(agent.id, narrowed)).status).toBe(200);
    // `github` is a connector of the workspace, so its rule is stored by id (ADR-0113 SD13, #1109).
    const storedDeny = `mcp__connector-${CONNECTOR_ID}__delete_repo`;

    const response = await putPolicy(agent.id, OPENAI_BODY);

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: {
        code: 'engine_switch_would_widen',
        details: [storedDeny, 'mcp__jira__*'],
        message: expect.stringContaining(`${storedDeny} (github), mcp__jira__*.`) as unknown,
      },
    });
    expect(await readPolicy(agent.id)).toEqual({
      ...narrowed,
      tools: { ...narrowed.tools, deny: ['Bash', storedDeny, 'mcp__jira__*'] },
    });
  });

  describe('connectorNames: the stored connector-<id> rules, labelled for a person (#1121)', () => {
    const GONE_ID = '99999999-9999-4999-8999-999999999999';

    function denying(deny: string[]): AgentPolicy {
      const stored = validPolicy({ skills: { mode: 'allowlist', names: [] } });
      if (stored.engine !== 'claude-agent-sdk') throw new Error('fixture');
      return { ...stored, tools: { ...stored.tools, deny } };
    }

    it('answers the connector name next to the stored rule, on GET and on the PUT that saved it', async () => {
      useMemoryRuntime();
      const agent = await createAsBuilderA();
      const server = `connector-${CONNECTOR_ID}`;

      const saved = await putPolicy(agent.id, denying(['mcp__github__delete_repo']));

      expect(saved.status).toBe(200);
      const expected = {
        policy: denying([`mcp__${server}__delete_repo`]),
        source: 'stored',
        connectorNames: { [server]: 'github' },
      };
      expect(await saved.json()).toEqual(expected);
      expect(await readPolicyBody(agent.id)).toEqual(expected);
    });

    it('omits the field when no rule is stored by connector id', async () => {
      useMemoryRuntime();
      const agent = await createAsBuilderA();
      expect((await putPolicy(agent.id, denying(['Bash', 'mcp__jira__*']))).status).toBe(200);

      expect(await readPolicyBody(agent.id)).not.toHaveProperty('connectorNames');
    });

    it('opens no version store for a policy with no rule stored by connector id', async () => {
      const versions = useMemoryRuntime();
      const agent = await createAsBuilderA();
      expect((await putPolicy(agent.id, denying(['Bash', 'mcp__jira__*']))).status).toBe(200);
      installTestDomains({
        agentVersions: {
          versions: {
            ...versions,
            forWorkspace: () => Promise.reject(new Error('unexpected version store read')),
          },
        },
      });

      expect(await readPolicyBody(agent.id)).toEqual({
        policy: denying(['Bash', 'mcp__jira__*']),
        source: 'stored',
      });
    });

    it('leaves the rule of a connector the workspace no longer has unlabelled', async () => {
      useMemoryRuntime();
      const agent = await createAsBuilderA();
      const gone = `mcp__connector-${GONE_ID}__x`;
      expect((await putPolicy(agent.id, denying([gone]))).status).toBe(200);

      const response = await readPolicyBody(agent.id);

      expect(response).not.toHaveProperty('connectorNames');
      expect(response['policy']).toEqual(denying([gone]));
    });
  });

  it('carries nothing for an agent with no stored policy: its checkboxes are the whole narrowing', async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();

    const response = await putPolicy(agent.id, OPENAI_BODY);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ policy: OPENAI_BODY, source: 'stored' });
  });

  it('carries withheld switches back into tools.deny on the reverse switch', async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();
    expect(
      (await putPolicy(agent.id, { ...OPENAI_BODY, withheldPermissions: ['runCommands'] })).status,
    ).toBe(200);
    const back = validPolicy({ skills: { mode: 'allowlist', names: [] } });
    if (back.engine !== 'claude-agent-sdk') throw new Error('fixture');

    const response = await putPolicy(agent.id, { ...back, tools: { ...back.tools, deny: [] } });

    expect(response.status, await response.clone().text()).toBe(200);
    const { policy } = (await response.json()) as { policy: AgentPolicy };
    expect(policy.engine === 'claude-agent-sdk' && policy.tools.deny).toEqual([
      'Bash',
      'BashOutput',
      'KillShell',
    ]);
  });

  it('replaces verbatim on the same engine, which is how an owner widens on purpose', async () => {
    useMemoryRuntime();
    const agent = await createAsBuilderA();
    expect(
      (await putPolicy(agent.id, { ...OPENAI_BODY, withheldPermissions: ['runCommands'] })).status,
    ).toBe(200);

    const response = await putPolicy(agent.id, OPENAI_BODY);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ policy: OPENAI_BODY, source: 'stored' });
  });
});
