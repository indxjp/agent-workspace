import { afterEach, describe, expect, it } from 'vitest';
import { GET as getRoute } from './route';
import type { AgentPolicy } from '../../../../../contracts/agents';
import { clearEnginesRegisteredForTests } from '../../../../../server/engines/registry';
import {
  CONNECTOR_ID,
  createWithAssignments,
  idContext,
  putPolicy,
  registerClaudeWithout,
  request,
  SKILL_ID,
  useMemoryRuntime,
  validPolicy,
  WORKSPACE_A,
} from './policy.test-support';

/**
 * ADR-0065 D3's "refuse, never ignore", at agent save (#318).
 *
 * The test descriptor is a `claude-agent-sdk` descriptor with a capability removed, and it
 * *replaces* the built-in one (see `apps/web/server/engines/registry.ts`): `AgentPolicy` has one
 * arm, so no policy body can name a different engine and still parse, and a deployment that
 * installs the engine without MCP is the state this refusal is actually about.
 */
describe('PUT /api/agents/:id/policy — engine capability check', () => {
  afterEach(() => {
    clearEnginesRegisteredForTests();
  });

  it('refuses an agent with a connector on an engine whose mcp is false', async () => {
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [],
      connectorIds: [CONNECTOR_ID],
      storageGrants: [],
    });
    registerClaudeWithout('mcp');

    const response = await putPolicy(
      agent.id,
      validPolicy({ skills: { mode: 'allowlist', names: [] } }),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      // The capability rides in `details` as one entry, so a client branches on it, not on prose.
      error: { code: 'engine_capability_unsupported', details: ['mcp'] },
    });
  });

  it('refuses an agent with a skill on an engine whose skills is false', async () => {
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [SKILL_ID],
      connectorIds: [],
      storageGrants: [],
    });
    registerClaudeWithout('skills');

    const response = await putPolicy(agent.id, validPolicy());

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'engine_capability_unsupported', details: ['skills'] },
    });
  });

  it('does not store the refused policy: the agent still reads its compiled one', async () => {
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [],
      connectorIds: [CONNECTOR_ID],
      storageGrants: [],
    });
    registerClaudeWithout('mcp');
    await putPolicy(agent.id, validPolicy({ skills: { mode: 'allowlist', names: [] } }));

    const read = await getRoute(
      request('GET', `/api/agents/${agent.id}/policy`, {
        workspace: WORKSPACE_A,
        actor: 'builder-a@example.test',
      }),
      idContext(agent.id),
    );
    const { policy } = (await read.json()) as { policy: AgentPolicy };
    expect(policy.limits).toEqual({ maxTurns: null, maxBudgetUsd: null });
  });

  it('accepts the same agent on the engine as this deployment really registers it', async () => {
    // "Nothing changes for claude-agent-sdk agents": the same connector, the same policy, no test
    // descriptor — a 200. Without this, the two refusals above would also pass for an engine that
    // refused everything.
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [SKILL_ID],
      connectorIds: [CONNECTOR_ID],
      storageGrants: [],
    });

    const response = await putPolicy(agent.id, validPolicy());

    expect(response.status, await response.clone().text()).toBe(200);
  });

  it('refuses an engine with no skills only when a skill would really be materialised', async () => {
    // An allowlist naming nothing hands the engine no skill, so there is nothing to refuse — the
    // check is about what a run receives, not about what the agent happens to be assigned.
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [SKILL_ID],
      connectorIds: [],
      storageGrants: [],
    });
    registerClaudeWithout('skills');

    const response = await putPolicy(
      agent.id,
      validPolicy({ skills: { mode: 'allowlist', names: [] } }),
    );

    expect(response.status, await response.clone().text()).toBe(200);
  });
});
