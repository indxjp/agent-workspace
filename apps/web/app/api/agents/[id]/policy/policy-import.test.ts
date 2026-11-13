import { describe, expect, it } from 'vitest';
import type { AgentPolicy } from '../../../../../contracts/agents';
import {
  createWithAssignments,
  putPolicy,
  SKILL_ID,
  useMemoryRuntime,
} from './policy.test-support';

/**
 * `aw.agents.import` (ADR-0076) is a client-side composition: `POST /api/agents` with the resolved
 * assignments, then — for a stored policy — this `PUT`. So an imported `openai-agents` definition
 * meets exactly the checks a hand-made `PUT` does, on an agent whose column is still NULL: a
 * creation, not a switch, so nothing is carried (ADR-0074 D12).
 */
describe('PUT /api/agents/:id/policy — the step that stores an imported openai-agents definition', () => {
  const OPENAI_DEFINITION_POLICY: AgentPolicy = {
    engine: 'openai-agents',
    skills: { mode: 'allowlist', names: [] },
    limits: { maxTurns: 20, maxBudgetUsd: null },
    withheldPermissions: ['writeFiles', 'runCommands'],
  };

  it('stores the definition verbatim, withheld switches included, with nothing carried', async () => {
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [],
      connectorIds: [],
      storageGrants: [],
    });

    const response = await putPolicy(agent.id, OPENAI_DEFINITION_POLICY);

    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toEqual({ policy: OPENAI_DEFINITION_POLICY, source: 'stored' });
  });

  it('refuses 422 engine_capability_unsupported when the definition assigns a skill', async () => {
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [SKILL_ID],
      connectorIds: [],
      storageGrants: [],
    });

    const response = await putPolicy(agent.id, {
      ...OPENAI_DEFINITION_POLICY,
      skills: { mode: 'allowlist', names: ['triage'] },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'engine_capability_unsupported', details: ['skills'] },
    });
  });

  it('refuses 400 for a withheld switch the contract does not know', async () => {
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [],
      connectorIds: [],
      storageGrants: [],
    });

    const response = await putPolicy(agent.id, {
      ...OPENAI_DEFINITION_POLICY,
      withheldPermissions: ['launchMissiles'],
    });

    expect(response.status).toBe(400);
  });

  it('refuses 400 unsupported_engine for an engine this deployment does not register', async () => {
    useMemoryRuntime();
    const agent = await createWithAssignments({
      files: [],
      skillIds: [],
      connectorIds: [],
      storageGrants: [],
    });

    const response = await putPolicy(agent.id, {
      ...OPENAI_DEFINITION_POLICY,
      engine: 'no-such-engine',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'unsupported_engine' } });
  });
});
