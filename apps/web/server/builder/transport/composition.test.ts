import { createInMemoryWorkspaceScopeResolver } from '@agent-workspace/core/db';
import { AgentVersionBodySchema } from '@indx-workspace/contracts/agent-versions';
import { FEATURE_IDS, type FeatureId } from '@indx-workspace/contracts/features';
import { afterEach, describe, expect, it } from 'vitest';

import { clearFeatureSwitches, configureFeatureSwitches } from '../../features/runtime';
import { versionRequest } from '../../agent-versions/fixtures';
import { createInMemoryAgentVersionStoreProvider } from '../../agent-versions/memory-store';
import { createInMemoryAgentStoreProvider } from '../../agents/memory-store';
import { createInMemoryConnectorsStoreProvider } from '../../connectors/memory-store';
import { createInMemoryModelsStoreProvider } from '../../models/memory-store';
import { createMemoryDirectory } from '../../rbac/memory-directory';
import { createInMemoryRuntimeProfileStoreProvider } from '../../runtimes/memory-store';
import { callContextOf } from '../testing/context';
import {
  builderRunReader,
  productionBuilderPorts,
  type BuilderCompositionRoot,
  type BuilderRunDatabase,
} from './composition';
import type { RunIdentity } from './run-caller';

const WORKSPACE = 'ws-1';
const RUN: RunIdentity = {
  kind: 'run',
  workspaceId: WORKSPACE,
  runId: 'run-1',
  sessionId: 'session-1',
  agentId: 'agent-1',
};

/** The production ports over in-memory stores, with `directory` as given, and the version store behind them. */
function portsOver(directory: BuilderCompositionRoot['directory']) {
  const agents = createInMemoryAgentStoreProvider();
  const versions = createInMemoryAgentVersionStoreProvider({ agents });
  const scopes = createInMemoryWorkspaceScopeResolver([{ id: WORKSPACE, slug: 'acme' }]);
  const ports = productionBuilderPorts({
    agents,
    deploymentPolicy: null,
    versions: {
      versions,
      ceiling: { kind: 'disabled' },
      toolHost: false,
      toolDomainsRefusal: null,
    },
    connectors: createInMemoryConnectorsStoreProvider(),
    models: createInMemoryModelsStoreProvider([WORKSPACE]),
    runtimeProfiles: createInMemoryRuntimeProfileStoreProvider(),
    skills: () => Promise.resolve({ status: 200, body: { skills: [] } }),
    storageConnections: () => null,
    toolBundles: () => null,
    journal: {
      repositories: {
        forScope: () => ({
          record: () => Promise.resolve(true),
          listForRun: () => Promise.resolve([]),
          findCall: () => Promise.resolve(null),
          listSpentInputs: () => Promise.resolve([]),
        }),
      },
      scopes,
    },
    directory,
    approvals: { scopes, runs: { forScope: () => ({ get: () => Promise.resolve(null) }) } },
    runApi: () => null,
  });
  return { ports, versions };
}

describe('productionBuilderPorts', () => {
  afterEach(clearFeatureSwitches);

  it('reads the builder feature from the workspace switch, and asks for the call’s own workspace', async () => {
    const { ports } = portsOver(createMemoryDirectory({ users: [] }));
    const asked: string[] = [];
    let enabled: readonly FeatureId[] = FEATURE_IDS;
    configureFeatureSwitches({
      enabledFor: (workspaceId) => {
        asked.push(workspaceId);
        return Promise.resolve(enabled);
      },
    });
    const ctx = callContextOf(WORKSPACE, 'owner');
    await expect(ports.feature.enabled(ctx)).resolves.toBe(true);
    enabled = FEATURE_IDS.filter((id) => id !== 'builder');
    await expect(ports.feature.enabled(ctx)).resolves.toBe(false);
    expect(asked).toEqual([WORKSPACE, WORKSPACE]);
  });

  it('builds the approval and runner ports; a run with no record is granted nothing', async () => {
    const { ports } = portsOver(createMemoryDirectory({ users: [] }));
    const ctx = callContextOf(WORKSPACE, 'builder');
    await expect(ports.approval.status(ctx, { tool: 'draft_save', arguments: {} })).resolves.toBe(
      'missing',
    );
    await expect(
      ports.runner.evaluate(callContextOf(WORKSPACE, null), 'agent-1', 1),
    ).resolves.toMatchObject({ ok: false, code: 'no_caller' });
  });

  it('names the person in the agent-created row by their member email, and refuses a non-member', async () => {
    const directory = createMemoryDirectory({
      users: [{ email: 'ada@example.test', name: 'Ada', workspaceId: WORKSPACE, role: 'builder' }],
    });
    const [member] = await directory.forWorkspace(WORKSPACE).listMemberships();
    if (member === undefined) throw new Error('the directory holds one member');
    const { ports, versions } = portsOver(directory);
    const body = AgentVersionBodySchema.parse(versionRequest().body);

    const saved = await ports.store.save(
      callContextOf(WORKSPACE, 'builder', member.principalId, member.userId),
      { body },
    );
    expect(saved.ok).toBe(true);
    expect(versions.audits()).toMatchObject([
      {
        action: 'agent-created',
        actorPrincipalId: member.principalId,
        actorLabel: member.email,
        details: { via: 'builder', builderRunId: 'run-1', version: 1 },
      },
    ]);

    await expect(
      ports.store.save(callContextOf(WORKSPACE, 'builder', 'not-a-member'), { body }),
    ).rejects.toThrow();
    expect(versions.audits()).toHaveLength(1);
  });
});

type RunRow = { agentId: string; model: string | null; agentVersion?: number | null };

/** One workspace holding `run` (if given) as `run-1`, and version 3 of `agent-1` as `version-3`. */
function database(
  run: RunRow | null,
  scope: string | null = 'scope-1',
): BuilderRunDatabase<string> {
  return {
    scopes: { forWorkspaceId: (id) => Promise.resolve(id === WORKSPACE ? scope : null) },
    runs: {
      forScope: () => ({ get: (id) => Promise.resolve(id === 'run-1' ? run : null) }),
    },
    agentVersions: {
      forScope: () => ({
        find: (agentId, number) =>
          Promise.resolve(
            agentId === 'agent-1' && number === 3
              ? { id: 'version-3', number: 3, summary: 'v3' }
              : null,
          ),
      }),
    },
  };
}

describe('builderRunReader', () => {
  const pinned: RunRow = { agentId: 'agent-1', model: 'model-1', agentVersion: 3 };

  it('reads the run model and the id of the version its session pins', async () => {
    await expect(builderRunReader(database(pinned))(RUN)).resolves.toStrictEqual({
      modelId: 'model-1',
      agentVersion: { id: 'version-3', number: 3, summary: 'v3' },
    });
  });

  it.each([
    ['an unknown workspace', database(pinned, null), RUN],
    ['a missing run', database(pinned), { ...RUN, runId: 'run-2' }],
    ['another agent than the token names', database({ ...pinned, agentId: 'agent-2' }), RUN],
    ['a run without a model', database({ ...pinned, model: null }), RUN],
    ['a run with no pinned version', database({ ...pinned, agentVersion: null }), RUN],
    ['a run row without a version column', database({ agentId: 'agent-1', model: 'model-1' }), RUN],
    ['a pinned version with no row', database({ ...pinned, agentVersion: 4 }), RUN],
  ] as const)('answers null for %s', async (_label, db, run) => {
    await expect(builderRunReader(db)(run)).resolves.toBeNull();
  });
});
