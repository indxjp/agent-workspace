import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_VERSION_PROBLEM_CODES } from '@indx-workspace/contracts/agent-versions';

import { clearEnginesRegisteredForTests } from '../engines/registry';
import { FIXTURE_POLICY, fromVersionRequest, versionRequest } from './fixtures';
import {
  agent,
  refusalOf,
  storeWith,
  validateAgentFromVersion,
  validateStoredVersion,
} from './pipeline.test-support';

afterEach(() => {
  clearEnginesRegisteredForTests();
});

describe('validateAgentFromVersion (S1-06)', () => {
  it('accepts a valid request: nothing to carry for a new agent, the stored policy as authored', async () => {
    const result = await validateAgentFromVersion(fromVersionRequest(), {
      store: await storeWith(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.version.body.definition.agent.name).toBe('Support triage');
    expect(result.policyToStore).toEqual(FIXTURE_POLICY);
  });

  it('keeps the version. prefix on every parse issue', async () => {
    const request = fromVersionRequest();
    const result = await validateAgentFromVersion(
      { ...request, version: { ...request.version, summary: ' padded ' } },
      { store: await storeWith() },
    );
    const refusal = refusalOf(result);
    expect(refusal.status).toBe(400);
    expect(refusal.body).toMatchObject({ error: { code: 'invalid_agent_version' } });
    expect(JSON.stringify(refusal.body)).toContain('version.summary: ');
  });

  it('refuses the legacy keys beside version: the two shapes never overlap', async () => {
    const result = await validateAgentFromVersion(
      { ...fromVersionRequest(), name: 'Support triage' },
      { store: await storeWith() },
    );
    expect(refusalOf(result)).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_agent_version' } },
    });
  });

  it('answers unsupported_engine from the raw envelope when the parse fails on the engine', async () => {
    const request = fromVersionRequest();
    const raw = {
      ...request,
      version: {
        ...request.version,
        body: {
          ...request.version.body,
          definition: { ...request.version.body.definition, policy: { engine: 'acp' } },
        },
      },
    };
    const result = await validateAgentFromVersion(raw, { store: await storeWith() });
    expect(refusalOf(result)).toMatchObject({
      status: 400,
      body: { error: { code: 'unsupported_engine', details: ['acp'] } },
    });
  });

  it('prefixes an unstorable string with version.', async () => {
    const result = await validateAgentFromVersion(
      fromVersionRequest({ instructions: 'before\u0000after' }),
      { store: await storeWith() },
    );
    expect(refusalOf(result)).toMatchObject({
      status: 400,
      body: {
        error: {
          code: 'invalid_agent_version',
          details: [
            'version.body.definition.agent.instructions: must not contain U+0000 or an unpaired ' +
              'UTF-16 surrogate, which the version store cannot hold',
          ],
        },
      },
    });
  });

  it('runs steps 2-6: a missing skill is refused as a save would refuse it', async () => {
    const result = await validateAgentFromVersion(
      fromVersionRequest({ resources: { skills: ['triage'] } }),
      { store: await storeWith() },
    );
    expect(refusalOf(result)).toMatchObject({
      status: AGENT_VERSION_PROBLEM_CODES.agent_definition_references_missing,
      body: { error: { details: ['skill:triage'] } },
    });
  });
});

describe('validateStoredVersion (S1-06)', () => {
  it('re-resolves a stored body to the ids the workspace has today', async () => {
    const stored = versionRequest({ resources: { connectors: ['tickets'] } }).body;
    const result = await validateStoredVersion(stored, agent(), {
      store: await storeWith({ connector: [{ id: 'c-today', name: 'tickets' }] }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.references.connectorIds).toEqual(['c-today']);
  });

  it('refuses a stored body whose reference was deleted since it was saved', async () => {
    const stored = versionRequest({ resources: { connectors: ['tickets'] } }).body;
    const result = await validateStoredVersion(stored, agent(), {
      store: await storeWith(),
    });
    expect(refusalOf(result)).toMatchObject({
      status: 422,
      body: {
        error: { code: 'agent_definition_references_missing', details: ['connector:tickets'] },
      },
    });
  });

  it("checks the engine switch against the agent's current stored policy", async () => {
    const stored = versionRequest({
      policy: { engine: 'openai-agents', skills: { mode: 'all' }, limits: FIXTURE_POLICY.limits },
    }).body;
    const current = agent({
      policy: { ...FIXTURE_POLICY, tools: { ...FIXTURE_POLICY.tools, deny: ['mcp__github__*'] } },
    });
    const result = await validateStoredVersion(stored, current, {
      store: await storeWith(),
    });
    expect(refusalOf(result)).toMatchObject({
      status: 422,
      body: { error: { code: 'engine_switch_would_widen' } },
    });
  });

  it('refuses a stored version whose engine this deployment no longer registers', async () => {
    const result = await validateStoredVersion(versionRequest().body, agent(), {
      store: await storeWith(),
      registered: ['pi'],
    });
    expect(refusalOf(result)).toMatchObject({
      status: 400,
      body: { error: { code: 'unsupported_engine' } },
    });
  });
});
