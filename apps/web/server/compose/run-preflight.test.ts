import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { describe, expect, it } from 'vitest';

import { createInMemoryAgentStoreProvider } from '../agents/memory-store';
import type { DeploymentDefaultModels } from '../models/deployment-default';
import type { DiscoverModelsResult } from '../models/discovery';
import { createInMemoryModelsStoreProvider } from '../models/memory-store';
import type { ModelsStoreProvider } from '../models/store';
import { createInMemoryRuntimeProfileStoreProvider } from '../runtimes/memory-store';
import type { ModelSelection } from '../runs/environment';
import {
  codeLaunchedRunFailure,
  createRunPreflight,
  credentialRejectedFailure,
  modelNotFoundFailure,
  modelResolutionRefusal,
  runStartRefusalError,
} from './run-preflight';

const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const SESSION = '44444444-4444-4444-8444-444444444444';
const PROJECT = '55555555-5555-4555-8555-555555555555';
const OWNER = {
  principalId: '77777777-7777-4777-8777-777777777777',
  userId: '66666666-6666-4666-8666-666666666666',
};
const PERMISSIONS = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

/** One workspace with a ready `anthropic` connection whose discovery offers `claude-sonnet-4-5`. */
async function fixture(options: {
  readonly withProfile: boolean;
  readonly agentModel: boolean;
  readonly workspaceDefault: boolean;
  /** A second ready connection set as the default of {@link PROJECT}. */
  readonly projectDefault?: boolean;
  /**
   * The agent names the connection but no model, as a scaffolded `model: 'default'` agent is
   * stored (issue #506). Ignored when {@link agentModel} is set.
   */
  readonly agentConnectionOnly?: boolean;
  /** The deployment's default model per provider (issue #506); empty when omitted. */
  readonly deploymentDefaults?: DeploymentDefaultModels;
  /** The ready connection's name; `'anthropic default'` when omitted. */
  readonly connectionName?: string;
  /**
   * The agent names a model but no connection, as a `{ connection: 'default', id }` agent pushed
   * before the workspace had a `default` connection is stored (C7). Ignored with {@link agentModel}.
   */
  readonly agentModelWithoutConnection?: boolean;
  /** The deployment's policy ceiling (S2-04c); none when omitted. */
  readonly policyCeiling?: ProjectPolicy;
}) {
  const models = createInMemoryModelsStoreProvider([WORKSPACE]);
  const connection = await models.forWorkspace(WORKSPACE).create({
    name: options.connectionName ?? 'anthropic default',
    provider: 'anthropic',
    apiKey: 'sk-test',
    config: {},
  });
  if (connection.kind !== 'created') throw new Error('fixture connection');
  const connectionId = connection.connection.id;

  const profiles = createInMemoryRuntimeProfileStoreProvider();
  const profile = await profiles.forWorkspace(WORKSPACE).create({
    name: 'docker default',
    driver: 'docker',
    runtimeConnectionId: null,
    cpu: null,
    memoryMb: null,
    diskMb: null,
    networkPolicy: 'open',
    allowedDomains: null,
    filesystem: 'read-write',
    persistPaths: null,
    timeoutSeconds: null,
    idleTimeoutSeconds: null,
    driverConfig: null,
  });
  if (profile.kind !== 'created') throw new Error('fixture profile');

  const agents = createInMemoryAgentStoreProvider();
  const agent = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'General',
      instructions: '',
      modelConnectionId:
        options.agentModel || options.agentConnectionOnly === true ? connectionId : null,
      model:
        options.agentModel || options.agentModelWithoutConnection === true
          ? 'claude-sonnet-4-5'
          : null,
      runtimeProfileId: options.withProfile ? profile.profile.id : null,
      permissions: PERMISSIONS,
    },
    OWNER,
  );
  if (agent.kind !== 'created') throw new Error('fixture agent');

  const workspaceDefault: ModelSelection | null = options.workspaceDefault
    ? { connectionId, model: 'claude-sonnet-4-5' }
    : null;
  const discover = (): Promise<DiscoverModelsResult> =>
    Promise.resolve({
      ok: true,
      stale: false,
      models: [
        {
          connectionId,
          providerModelId: 'claude-sonnet-4-5',
          displayName: 'Claude Sonnet 4.5',
          capabilities: {
            streaming: true,
            toolUse: true,
            thinking: true,
            promptCaching: false,
            structuredOutput: true,
            contextManagement: true,
            webSearch: true,
            tokenCounting: false,
          },
        },
      ],
    });
  const projectDefaults = new Map<string, ModelSelection>();
  if (options.projectDefault === true) {
    const projectConnection = await models.forWorkspace(WORKSPACE).create({
      name: 'project connection',
      provider: 'anthropic',
      apiKey: 'sk-project',
      config: {},
    });
    if (projectConnection.kind !== 'created') throw new Error('fixture project connection');
    projectDefaults.set(PROJECT, {
      connectionId: projectConnection.connection.id,
      model: 'claude-opus-4-1',
    });
  }
  // Counts reads of the connection list: only the deployment layer's late binding of C7 reads it.
  let connectionListReads = 0;
  const countingModels: ModelsStoreProvider = {
    forWorkspace: (workspaceId) => {
      const store = models.forWorkspace(workspaceId);
      return {
        ...store,
        list: () => {
          connectionListReads += 1;
          return store.list();
        },
      };
    },
  };
  const preflight = createRunPreflight({
    agents,
    profiles,
    models: { models: countingModels, discover },
    workspaceDefault: () => Promise.resolve(workspaceDefault),
    projectDefault: () => Promise.resolve(null),
    projectDefaults: () => Promise.resolve(projectDefaults),
    deploymentDefaultModels: options.deploymentDefaults ?? {},
    policyCeiling: options.policyCeiling ?? null,
  });
  return {
    preflight,
    agents,
    agentId: agent.agent.id,
    connectionId,
    models,
    connectionListReads: () => connectionListReads,
  };
}

const query = (agentId: string) => ({
  workspaceId: WORKSPACE,
  agentId,
  sessionId: SESSION,
  modelOverride: null,
});

describe('createRunPreflight (issue #393)', () => {
  it('refuses an agent with no runtime profile with agent_runtime_profile_missing', async () => {
    const { preflight, agentId } = await fixture({
      withProfile: false,
      agentModel: true,
      workspaceDefault: true,
    });
    await expect(preflight.check(query(agentId))).resolves.toMatchObject({
      code: 'agent_runtime_profile_missing',
      message: expect.stringContaining('has no runtime profile') as unknown,
    });
  });

  it('refuses an agent that inherits a workspace default nobody set with model_connection_unresolved', async () => {
    const { preflight, agentId } = await fixture({
      withProfile: true,
      agentModel: false,
      workspaceDefault: false,
    });
    const refusal = await preflight.check(query(agentId));
    expect(refusal?.code).toBe('model_connection_unresolved');
    expect(refusal?.message).toContain('workspace default');
  });

  it('accepts an agent with a profile and a model, and an agent inheriting a working default', async () => {
    const own = await fixture({ withProfile: true, agentModel: true, workspaceDefault: false });
    await expect(own.preflight.check(query(own.agentId))).resolves.toBeNull();
    const inherits = await fixture({
      withProfile: true,
      agentModel: false,
      workspaceDefault: true,
    });
    await expect(inherits.preflight.check(query(inherits.agentId))).resolves.toBeNull();
  });

  it('describes what a run would use without calling the provider', async () => {
    const own = await fixture({ withProfile: true, agentModel: true, workspaceDefault: true });
    const ownDescription = await own.preflight.describe(WORKSPACE, own.agentId);
    expect(ownDescription?.outsideProject).toEqual({
      kind: 'runnable',
      source: 'agent',
      connectionId: own.connectionId,
      connectionName: 'anthropic default',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      runtimeProfileName: 'docker default',
    });
    const inherits = await fixture({
      withProfile: true,
      agentModel: false,
      workspaceDefault: true,
    });
    expect(
      (await inherits.preflight.describe(WORKSPACE, inherits.agentId))?.outsideProject,
    ).toMatchObject({ kind: 'runnable', source: 'workspace' });
    const missing = await fixture({ withProfile: false, agentModel: true, workspaceDefault: true });
    expect(
      (await missing.preflight.describe(WORKSPACE, missing.agentId))?.outsideProject,
    ).toMatchObject({ kind: 'unrunnable', code: 'agent_runtime_profile_missing' });
  });

  // PR #403 review: the description follows the real ladder, agent > project > workspace.
  it('describes a project default between the agent and the workspace default', async () => {
    const inherits = await fixture({
      withProfile: true,
      agentModel: false,
      workspaceDefault: true,
      projectDefault: true,
    });
    const described = await inherits.preflight.describe(WORKSPACE, inherits.agentId);
    expect(described?.outsideProject).toMatchObject({ source: 'workspace' });
    expect(described?.byProject.get(PROJECT)).toMatchObject({
      kind: 'runnable',
      source: 'project',
      connectionName: 'project connection',
      model: 'claude-opus-4-1',
    });

    // The project default alone makes an agent with no workspace default runnable in it.
    const projectOnly = await fixture({
      withProfile: true,
      agentModel: false,
      workspaceDefault: false,
      projectDefault: true,
    });
    const onlyInProject = await projectOnly.preflight.describe(WORKSPACE, projectOnly.agentId);
    expect(onlyInProject?.outsideProject).toMatchObject({
      kind: 'unrunnable',
      code: 'model_connection_unresolved',
    });
    expect(onlyInProject?.byProject.get(PROJECT)).toMatchObject({ source: 'project' });

    // The agent's own model ends the ladder: no project default can change it.
    const own = await fixture({
      withProfile: true,
      agentModel: true,
      workspaceDefault: true,
      projectDefault: true,
    });
    const ownDescription = await own.preflight.describe(WORKSPACE, own.agentId);
    expect(ownDescription?.outsideProject).toMatchObject({ source: 'agent' });
    expect(ownDescription?.byProject.size).toBe(0);
  });

  it('resolves a run that opens a new session with no project default', async () => {
    const inherits = await fixture({
      withProfile: true,
      agentModel: false,
      workspaceDefault: true,
    });
    await expect(
      inherits.preflight.check({ ...query(inherits.agentId), sessionId: null }),
    ).resolves.toBeNull();
  });
});

describe('runStartRefusalError', () => {
  it('carries the code at the front of its public message, for the run record', () => {
    const error = runStartRefusalError({ code: 'model_unavailable', message: 'gone.' });
    expect(error.code).toBe('model_unavailable');
    expect(error.publicMessage).toBe('model_unavailable: gone.');
  });
});

// PR #403 review: a model queued unvalidated (discovery was down) that the provider then refuses.
describe('modelNotFoundFailure', () => {
  const unvalidated = {
    layer: 'agent' as const,
    connectionName: 'anthropic default',
    model: 'claude-gone-1',
  };

  it('maps the provider model-not-found answers to the coded model_unavailable failure', () => {
    for (const reason of [
      '404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-gone-1"}}',
      'Error: The model `claude-gone-1` does not exist (model_not_found)',
      'model claude-gone-1 not found',
    ]) {
      const message = modelNotFoundFailure(reason, unvalidated);
      expect(message).toBe(
        'model_unavailable: model "claude-gone-1" is not available at the agent connection "anthropic default". Choose a model the connection offers.',
      );
    }
  });

  // The review of #506: at the deployment layer the connection is the agent's.
  it("names the deployment default model and the agent's connection at the deployment layer", () => {
    expect(
      modelNotFoundFailure('model claude-gone-1 not found', {
        ...unvalidated,
        layer: 'deployment',
      }),
    ).toBe(
      `model_unavailable: the deployment default model "claude-gone-1" is not available at the agent's model connection "anthropic default". Choose a model the connection offers.`,
    );
  });

  it('leaves every other failure alone', () => {
    expect(modelNotFoundFailure('rate_limit_error: slow down', unvalidated)).toBeNull();
    // A not-found code about something else (another model, a file) is not this model's absence.
    expect(modelNotFoundFailure('not_found_error: model: claude-other-2', unvalidated)).toBeNull();
    expect(modelNotFoundFailure('model_not_found', unvalidated)).toBeNull();
    expect(modelNotFoundFailure('file /workspace/a.txt not found', unvalidated)).toBeNull();
  });
});

// Issue #661: the engine stops a run whose key the provider rejects; the stored sentence is the
// control plane's own, naming the run's connection, never the runtime's text.
describe('credentialRejectedFailure', () => {
  const launched = {
    layer: 'agent' as const,
    connectionName: 'default',
    model: 'claude-sonnet-4-5',
  };

  it('codes an engine credential rejection with the connection it happened on', () => {
    expect(
      credentialRejectedFailure(
        'model_credential_rejected: the model provider rejected the API key (HTTP 401).',
        launched,
      ),
    ).toBe(
      'model_credential_rejected: the agent model connection "default": The provider rejected the API key (HTTP 401). Replace the key on this connection.',
    );
    expect(
      credentialRejectedFailure(
        'model_credential_rejected: the model provider rejected the API key (HTTP 403).',
        { ...launched, layer: 'deployment' },
      ),
    ).toBe(
      `model_credential_rejected: the agent's model connection "default": The provider rejected the API key (HTTP 403). Replace the key on this connection.`,
    );
  });

  it('never stores the runtime text, so nothing in it can leak', () => {
    const message = credentialRejectedFailure(
      'model_credential_rejected: key sk-ant-test-SENTINEL rejected',
      launched,
    );
    expect(message).toContain('HTTP 401');
    expect(message).not.toContain('SENTINEL');
  });

  it('leaves every other failure alone', () => {
    expect(credentialRejectedFailure('API Error: 500 usually temporary', launched)).toBeNull();
    expect(credentialRejectedFailure('authentication_failed (HTTP 401)', launched)).toBeNull();
  });
});

// Issue #661 review: the wiring that codes a launched run's runtime failure.
describe('codeLaunchedRunFailure', () => {
  const launched = {
    layer: 'agent' as const,
    connectionName: 'default',
    model: 'claude-gone-1',
    validated: true,
  };
  const notFound = 'model claude-gone-1 not found';

  it('codes a rejected key on a validated run', () => {
    expect(
      codeLaunchedRunFailure(
        'model_credential_rejected: the model provider rejected the API key (HTTP 401).',
        launched,
      ),
    ).toBe(
      'model_credential_rejected: the agent model connection "default": The provider rejected the API key (HTTP 401). Replace the key on this connection.',
    );
  });

  it('codes "model not found" only for an unvalidated run', () => {
    expect(codeLaunchedRunFailure(notFound, launched)).toBeNull();
    expect(codeLaunchedRunFailure(notFound, { ...launched, validated: false })).toBe(
      'model_unavailable: model "claude-gone-1" is not available at the agent connection "default". Choose a model the connection offers.',
    );
  });

  it('leaves a run with no launched model alone', () => {
    expect(
      codeLaunchedRunFailure('model_credential_rejected: rejected (HTTP 401).', undefined),
    ).toBeNull();
  });
});

// #403 follow-up: the rejected-key sentence comes from discovery and is not repeated.
describe('modelResolutionRefusal', () => {
  it('says to replace a rejected key exactly once', () => {
    const refusal = modelResolutionRefusal({
      ok: false,
      layer: 'agent',
      code: 'model_credential_rejected',
      reason:
        'the agent model connection "anthropic default": The provider rejected the API key (HTTP 401). Replace the key on this connection.',
    });
    expect(refusal.message.match(/Replace the/gu)).toHaveLength(1);
    expect(refusal.message.endsWith('Replace the key on this connection.')).toBe(true);
  });
});

describe('createRunPreflight — the deployment default layer (issue #506)', () => {
  it('queues an agent that names a connection but no model when the deployment sets a default', async () => {
    const { preflight, agentId } = await fixture({
      withProfile: true,
      agentModel: false,
      agentConnectionOnly: true,
      workspaceDefault: false,
      deploymentDefaults: { anthropic: 'claude-sonnet-4-5' },
    });
    await expect(preflight.check(query(agentId))).resolves.toBeNull();
    await expect(preflight.resolveModel(query(agentId))).resolves.toMatchObject({
      ok: true,
      layer: 'deployment',
      model: 'claude-sonnet-4-5',
    });
  });

  it('refuses the same agent, naming the deployment layer, when no default is configured', async () => {
    const { preflight, agentId } = await fixture({
      withProfile: true,
      agentModel: false,
      agentConnectionOnly: true,
      workspaceDefault: false,
    });
    const refusal = await preflight.check(query(agentId));
    expect(refusal?.code).toBe('model_connection_unresolved');
    expect(refusal?.message).toContain('sets no default model for provider "anthropic"');
    await expect(preflight.resolveModel(query(agentId))).resolves.toMatchObject({
      ok: false,
      layer: 'deployment',
    });
  });

  it('describes the deployment default without a provider call, and lets a project default win in its project', async () => {
    const { preflight, agentId, connectionId } = await fixture({
      withProfile: true,
      agentModel: false,
      agentConnectionOnly: true,
      workspaceDefault: false,
      projectDefault: true,
      deploymentDefaults: { anthropic: 'claude-sonnet-4-5' },
    });
    const described = await preflight.describe(WORKSPACE, agentId);
    expect(described?.outsideProject).toEqual({
      kind: 'runnable',
      source: 'deployment',
      connectionId,
      connectionName: 'anthropic default',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      runtimeProfileName: 'docker default',
    });
    expect(described?.byProject.get(PROJECT)).toMatchObject({
      kind: 'runnable',
      source: 'project',
      model: 'claude-opus-4-1',
    });
  });

  it('lets a workspace default win over the deployment default', async () => {
    const { preflight, agentId } = await fixture({
      withProfile: true,
      agentModel: false,
      agentConnectionOnly: true,
      workspaceDefault: true,
      deploymentDefaults: { anthropic: 'deployment-model' },
    });
    expect((await preflight.describe(WORKSPACE, agentId))?.outsideProject).toMatchObject({
      source: 'workspace',
      model: 'claude-sonnet-4-5',
    });
    await expect(preflight.resolveModel(query(agentId))).resolves.toMatchObject({
      ok: true,
      layer: 'workspace',
    });
  });

  it('describes an unconfigured deployment default as unrunnable', async () => {
    const { preflight, agentId } = await fixture({
      withProfile: true,
      agentModel: false,
      agentConnectionOnly: true,
      workspaceDefault: false,
      deploymentDefaults: { openai: 'gpt-5.1' },
    });
    const outside = (await preflight.describe(WORKSPACE, agentId))?.outsideProject;
    expect(outside).toMatchObject({ kind: 'unrunnable', code: 'model_connection_unresolved' });
    if (outside?.kind !== 'unrunnable') throw new Error('unreachable');
    expect(outside.reason).toContain('provider "anthropic"');
  });
});

// The review of #506: C7 stores `modelConnectionId: null` for a `model: 'default'` agent pushed
// before the workspace had a `default` connection, and an unchanged re-push is not re-applied. A
// run binds C7 again, so creating `default` later is enough.
describe('createRunPreflight — the default connection bound at run time (C7)', () => {
  it('runs an agent stored with no connection on the workspace connection named default', async () => {
    const { preflight, agentId, connectionId } = await fixture({
      withProfile: true,
      agentModel: false,
      workspaceDefault: false,
      connectionName: 'default',
      deploymentDefaults: { anthropic: 'claude-sonnet-4-5' },
    });
    await expect(preflight.check(query(agentId))).resolves.toBeNull();
    await expect(preflight.resolveModel(query(agentId))).resolves.toMatchObject({
      ok: true,
      layer: 'deployment',
      connectionId,
      model: 'claude-sonnet-4-5',
    });
    expect((await preflight.describe(WORKSPACE, agentId))?.outsideProject).toMatchObject({
      kind: 'runnable',
      source: 'deployment',
      connectionId,
      connectionName: 'default',
    });
  });

  // The orchestrator review of #506: C7 is bound in the deployment layer only, so a run an earlier
  // layer resolved on origin/main resolves there, on the same connection, unchanged.
  it('leaves an agent that names a model but no connection to the workspace default, as before', async () => {
    const { preflight, agentId, connectionId } = await fixture({
      withProfile: true,
      agentModel: false,
      agentModelWithoutConnection: true,
      workspaceDefault: true,
      connectionName: 'default',
      deploymentDefaults: { anthropic: 'claude-sonnet-4-5' },
    });
    await expect(preflight.resolveModel(query(agentId))).resolves.toMatchObject({
      ok: true,
      layer: 'workspace',
      connectionId,
      model: 'claude-sonnet-4-5',
    });
    expect((await preflight.describe(WORKSPACE, agentId))?.outsideProject).toMatchObject({
      kind: 'runnable',
      source: 'workspace',
      connectionId,
    });
  });

  it('never pairs a model named without a connection with the default connection', async () => {
    const { preflight, agentId, connectionListReads } = await fixture({
      withProfile: true,
      agentModel: false,
      agentModelWithoutConnection: true,
      workspaceDefault: false,
      connectionName: 'default',
      deploymentDefaults: { anthropic: 'claude-sonnet-4-5' },
    });
    await expect(preflight.resolveModel(query(agentId))).resolves.toEqual({
      ok: false,
      layer: 'workspace',
      code: 'model_connection_unresolved',
      reason:
        'no model connection resolves for this run: the agent names none and no workspace default is configured.',
    });
    expect((await preflight.describe(WORKSPACE, agentId))?.outsideProject).toMatchObject({
      kind: 'unrunnable',
      code: 'model_connection_unresolved',
    });
    expect(connectionListReads()).toBe(0);
  });

  it('resolves an agent with no model and no connection at the workspace layer when it has a default', async () => {
    const { preflight, agentId, connectionId, connectionListReads } = await fixture({
      withProfile: true,
      agentModel: false,
      workspaceDefault: true,
      connectionName: 'default',
      deploymentDefaults: { anthropic: 'deployment-model' },
    });
    await expect(preflight.resolveModel(query(agentId))).resolves.toMatchObject({
      ok: true,
      layer: 'workspace',
      connectionId,
      model: 'claude-sonnet-4-5',
    });
    expect((await preflight.describe(WORKSPACE, agentId))?.outsideProject).toMatchObject({
      kind: 'runnable',
      source: 'workspace',
      model: 'claude-sonnet-4-5',
    });
    // The late binding of C7 is the deployment layer's, so a run the workspace layer resolves
    // never looks the `default` connection up.
    expect(connectionListReads()).toBe(0);
  });

  it('refuses, naming the missing default connection, when the workspace has none', async () => {
    const { preflight, agentId } = await fixture({
      withProfile: true,
      agentModel: false,
      workspaceDefault: false,
      deploymentDefaults: { anthropic: 'claude-sonnet-4-5' },
    });
    const refusal = await preflight.check(query(agentId));
    expect(refusal?.code).toBe('model_connection_unresolved');
    expect(refusal?.message).toContain('no connection named "default"');
    await expect(preflight.resolveModel(query(agentId))).resolves.toMatchObject({
      ok: false,
      layer: 'deployment',
      code: 'model_connection_unresolved',
    });
    const outside = (await preflight.describe(WORKSPACE, agentId))?.outsideProject;
    if (outside?.kind !== 'unrunnable') throw new Error('expected an unrunnable description');
    expect(outside.reason).toContain('no connection named "default"');
  });

  it("describes a deleted connection at the deployment layer as the agent's connection", async () => {
    const { preflight, agentId, connectionId, models } = await fixture({
      withProfile: true,
      agentModel: false,
      agentConnectionOnly: true,
      workspaceDefault: false,
      deploymentDefaults: { anthropic: 'claude-sonnet-4-5' },
    });
    await models.forWorkspace(WORKSPACE).delete(connectionId);
    const outside = (await preflight.describe(WORKSPACE, agentId))?.outsideProject;
    if (outside?.kind !== 'unrunnable') throw new Error('expected an unrunnable description');
    expect(outside.reason).toMatch(/^the agent's model connection no longer exists\./u);
    const refusal = await preflight.check(query(agentId));
    expect(refusal?.message).toMatch(/^the agent's model connection \S+ no longer exists/u);
  });
});

describe('createRunPreflight meets the policy ceiling (S2-04c)', () => {
  const openaiAgents = {
    engine: 'openai-agents',
    skills: { mode: 'all' },
    limits: { maxTurns: null, maxBudgetUsd: null },
  } as const;

  it('refuses a model the S1-23 ladder resolves outside policy.models with policy_cannot_widen', async () => {
    const { preflight, agentId } = await fixture({
      withProfile: true,
      agentModel: false,
      agentConnectionOnly: true,
      workspaceDefault: false,
      deploymentDefaults: { anthropic: 'claude-sonnet-4-5' },
      policyCeiling: { models: ['claude-opus-4-1'] },
    });
    // The deployment layer resolved it, so no save path could have judged this model.
    await expect(preflight.resolveModel(query(agentId))).resolves.toMatchObject({
      ok: true,
      layer: 'deployment',
      model: 'claude-sonnet-4-5',
    });
    const refusal = await preflight.check(query(agentId));
    expect(refusal?.code).toBe('policy_cannot_widen');
    expect(refusal?.message).toContain('model:claude-sonnet-4-5');
  });

  it('refuses a stored engine outside policy.engines with policy_cannot_widen', async () => {
    const { preflight, agents, agentId } = await fixture({
      withProfile: true,
      agentModel: true,
      workspaceDefault: false,
      policyCeiling: { engines: ['claude-agent-sdk'] },
    });
    await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, openaiAgents);
    await expect(preflight.check(query(agentId))).resolves.toEqual({
      code: 'policy_cannot_widen',
      message:
        "the run asks for more than this deployment's policy ceiling allows: " +
        'engine:openai-agents. Choose an engine and a model the ceiling lists.',
    });
  });

  it('names the engine before the model, in C14 order', async () => {
    const { preflight, agents, agentId } = await fixture({
      withProfile: true,
      agentModel: true,
      workspaceDefault: false,
      policyCeiling: { engines: ['claude-agent-sdk'], models: ['claude-opus-4-1'] },
    });
    await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, openaiAgents);
    const refusal = await preflight.check(query(agentId));
    expect(refusal?.message).toContain('engine:openai-agents, model:claude-sonnet-4-5.');
  });

  it('queues a run whose engine and model the ceiling lists, even when the ceiling narrows it', async () => {
    const { preflight, agentId } = await fixture({
      withProfile: true,
      agentModel: true,
      workspaceDefault: false,
      policyCeiling: {
        engines: ['claude-agent-sdk'],
        models: ['claude-sonnet-4-5'],
        permissions: { readFiles: false },
        limits: { maxTurns: 1 },
      },
    });
    await expect(preflight.check(query(agentId))).resolves.toBeNull();
  });

  it('is unchanged without a ceiling', async () => {
    const { preflight, agents, agentId } = await fixture({
      withProfile: true,
      agentModel: true,
      workspaceDefault: false,
    });
    await agents.forWorkspace(WORKSPACE).replacePolicy(agentId, openaiAgents);
    await expect(preflight.check(query(agentId))).resolves.toBeNull();
  });
});
