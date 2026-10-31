import { log as webLogger } from '../../server/telemetry/logger';
import { createInMemoryObjectStoreProvider } from '@agent-workspace/core/storage';
import { isValidElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HomeChat } from '../../components/composer/home-chat';
import type { ComposerAgent } from '../../components/composer/model';
import { createInMemoryAgentStoreProvider } from '../../server/agents/memory-store';
import { createInMemoryConnectorsStoreProvider } from '../../server/connectors/memory-store';
import { createInMemoryModelsStoreProvider } from '../../server/models/memory-store';
import { createInMemoryCatalogStore } from '../../server/resources/catalog-store.memory';
import { InMemoryRunStore } from '../../server/runs/memory-store';
import HomePage from './page';
import {
  installTestDomains,
  installTestRunApi,
  resetTestRunApi,
} from '../../server/application-context-fixtures';
import { clearApplicationContext } from '../../server/application-context';
import { seedCatalogFile } from '@agent-workspace/core/db';

vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ toString: () => '__Host-aw_session=fixture' }),
}));

vi.mock('../../server/auth', () => ({
  getSession: () => Promise.resolve(null),
}));

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const AGENT = '22222222-2222-4222-8222-222222222222';
const CREATOR = '33333333-3333-4333-8333-333333333333';
const ASSIGNED_CONNECTOR = '66666666-6666-4666-8666-666666666666';
const UNASSIGNED_CONNECTOR = '77777777-7777-4777-8777-777777777777';

afterEach(() => {
  clearApplicationContext();
  resetTestRunApi();
  vi.restoreAllMocks();
});

async function configuredProjection(): Promise<{
  readonly agent: ComposerAgent;
  readonly readAssignments: ReturnType<typeof vi.fn>;
  readonly assignedFileId: string;
  readonly unassignedFileId: string;
}> {
  const agents = createInMemoryAgentStoreProvider({ newId: () => AGENT });
  const created = await agents.forWorkspace(WORKSPACE).create(
    {
      name: 'Research',
      instructions: 'Use only assigned resources.',
      modelConnectionId: null,
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    },
    { principalId: CREATOR, userId: CREATOR },
  );
  if (created.kind !== 'created') throw new Error(`agent fixture failed: ${created.kind}`);

  const catalog = createInMemoryCatalogStore();
  const seeded: string[] = [];
  for (const [path, sizeBytes] of [
    ['assigned/brief.md', 42],
    ['private/notes.md', 99],
  ] as const) {
    const row = await seedCatalogFile(catalog.forWorkspaceSync(WORKSPACE), {
      path,
      kind: 'file',
      sizeBytes,
      contentType: 'text/markdown',
      ownerPrincipalId: CREATOR,
      createdBy: CREATOR,
    });
    seeded.push(row.id);
  }
  const [assignedFileId, unassignedFileId] = seeded;
  if (assignedFileId === undefined || unassignedFileId === undefined) {
    throw new Error('file fixture failed');
  }

  const readAssignments = vi.fn(() =>
    Promise.resolve({
      files: [{ fileId: assignedFileId, access: 'read' as const }],
      skillIds: [],
      connectorIds: [ASSIGNED_CONNECTOR],
      storageGrants: [],
    }),
  );
  installTestDomains({
    agents: {
      agents,
      resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
      agentResources: {
        forWorkspace: () => ({
          get: readAssignments,
          replace: (_agentId, assignments) =>
            Promise.resolve({
              kind: 'updated',
              assignments: { ...assignments, storageGrants: assignments.storageGrants ?? [] },
            }),
        }),
      },
    },
  });

  installTestDomains({
    files: {
      kind: 'serving',
      runtime: {
        resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
        store: createInMemoryObjectStoreProvider(),
        catalog,
      },
    },
  });

  const connectors = createInMemoryConnectorsStoreProvider({
    newId: (() => {
      const ids = [ASSIGNED_CONNECTOR, UNASSIGNED_CONNECTOR];
      return () => {
        const id = ids.shift();
        if (id === undefined) throw new Error('connector fixture requested too many ids');
        return id;
      };
    })(),
  });
  for (const name of ['Assigned Search', 'Unassigned Admin']) {
    const outcome = await connectors.forWorkspace(WORKSPACE).create(
      {
        name,
        transport: 'stdio',
        command: 'fixture-command',
        args: [],
        url: null,
        authType: 'none',
        credential: null,
      },
      { principalId: CREATOR, userId: CREATOR },
    );
    if (outcome.kind !== 'created') throw new Error(`connector fixture failed: ${outcome.kind}`);
  }
  installTestDomains({
    connectors: {
      kind: 'serving',
      runtime: {
        connectors,
        resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
        identifyActor: () => Promise.resolve({ principalId: CREATOR, userId: CREATOR }),
        recordAudit: () => Promise.resolve(),
      },
    },
    models: { kind: 'unavailable' },
  });

  const home = await HomePage({ searchParams: Promise.resolve({}) });
  if (!isValidElement<ComponentProps<typeof HomeChat>>(home)) {
    throw new Error('HomePage did not return the HomeChat boundary');
  }
  const projection = home.props.agents;
  if (projection.kind !== 'agents') throw new Error(projection.reason);
  const agent = projection.agents[0];
  if (agent.id !== AGENT) throw new Error('HomePage did not project the configured agent');
  return { agent, readAssignments, assignedFileId, unassignedFileId };
}

describe('composer projection characterization', () => {
  describe('assigned resource projection', () => {
    let fixture: Awaited<ReturnType<typeof configuredProjection>>;

    beforeEach(async () => {
      fixture = await configuredProjection();
    });

    it('RF-502 builds the configured agent projection used by the characterization', () => {
      expect(fixture.agent).toMatchObject({ id: AGENT, name: 'Research' });
      expect(fixture.readAssignments).not.toHaveBeenCalled();
      expect(fixture.agent.files).toEqual([]);
      expect(fixture.agent.connectors).toEqual([]);
    });

    it.fails(
      'RF-502 projects only the persisted File and Connector assignments into HomeChat (expected failure until RF-502)',
      () => {
        expect(fixture.agent.files.map(({ id }) => id)).toEqual([fixture.assignedFileId]);
        expect(fixture.agent.connectors.map(({ id, name }) => ({ id, name }))).toEqual([
          { id: ASSIGNED_CONNECTOR, name: 'Assigned Search' },
        ]);
        expect(JSON.stringify(fixture.agent)).not.toContain(fixture.unassignedFileId);
        expect(JSON.stringify(fixture.agent)).not.toContain(UNASSIGNED_CONNECTOR);
      },
    );
  });

  describe('unused model connection query', () => {
    let fixture: Awaited<ReturnType<typeof configuredProjection>>;
    let homeProps: ComponentProps<typeof HomeChat>;
    let list: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      fixture = await configuredProjection();
      const models = createInMemoryModelsStoreProvider([WORKSPACE]).forWorkspace(WORKSPACE);
      list = vi.spyOn(models, 'list');
      installTestDomains({
        models: {
          kind: 'serving',
          runtime: {
            resolveActor: () =>
              Promise.resolve({
                kind: 'workspace',
                workspaceId: WORKSPACE,
                principalId: CREATOR,
                userId: CREATOR,
                userLabel: 'creator@example.test',
                role: 'owner',
                scope: null,
              }),
            models: { forWorkspace: () => models },
            probe: () =>
              Promise.resolve({ ok: false, status: null, latencyMs: 0, message: 'unused fixture' }),
            discover: () => Promise.resolve({ ok: true, models: [], stale: false }),
            audit: () => Promise.resolve(),
            log: () => undefined,
          },
        },
      });

      const home = await HomePage({ searchParams: Promise.resolve({}) });
      if (!isValidElement<ComponentProps<typeof HomeChat>>(home)) {
        throw new Error('HomePage did not return the HomeChat boundary');
      }
      homeProps = home.props;
    });

    it('RF-502 builds the configured agent projection used by the characterization', () => {
      expect(fixture.agent).toMatchObject({ id: AGENT, name: 'Research' });
      expect(list).toHaveBeenCalled();
      expect(homeProps).toHaveProperty('modelConnections');
    });

    it.fails(
      'RF-502 does not query modelConnections that HomeChat does not consume (expected failure until RF-502)',
      () => {
        expect(homeProps).not.toHaveProperty('modelConnections');
        expect(list).not.toHaveBeenCalled();
      },
    );
  });
});

describe('version pin', () => {
  async function homePropsFor(
    params: Readonly<Record<string, string>>,
  ): Promise<ComponentProps<typeof HomeChat>> {
    await configuredProjection();
    const home = await HomePage({ searchParams: Promise.resolve(params) });
    if (!isValidElement<ComponentProps<typeof HomeChat>>(home)) {
      throw new Error('HomePage did not return the HomeChat boundary');
    }
    return home.props;
  }

  it('pins HomeChat to ?agent and ?version', async () => {
    const props = await homePropsFor({ agent: AGENT, version: '2' });
    expect(props.agent).toEqual({ id: AGENT, locked: true });
    expect(props.version).toBe(2);
  });

  it('passes neither prop for an invalid pin', async () => {
    const props = await homePropsFor({ agent: AGENT, version: '0' });
    expect(props).not.toHaveProperty('agent');
    expect(props).not.toHaveProperty('version');
  });

  it('passes neither prop for an agent that is not a uuid', async () => {
    const props = await homePropsFor({ agent: 'not-a-uuid', version: '2' });
    expect(props).not.toHaveProperty('agent');
    expect(props).not.toHaveProperty('version');
  });
});

// #403 follow-up: one agent whose run target cannot be described must not fail the home page.
describe('run-target description failure', () => {
  it('shows the failing agent as unknown, keeps the others, and logs the failure', async () => {
    const FAILING = '88888888-8888-4888-8888-888888888888';
    const HEALTHY = '99999999-9999-4999-8999-999999999999';
    const ids = [FAILING, HEALTHY];
    const agents = createInMemoryAgentStoreProvider({
      newId: () => {
        const id = ids.shift();
        if (id === undefined) throw new Error('agent fixture requested too many ids');
        return id;
      },
    });
    for (const name of ['Broken', 'Healthy']) {
      const created = await agents.forWorkspace(WORKSPACE).create(
        {
          name,
          instructions: '',
          modelConnectionId: null,
          model: null,
          permissions: {
            readFiles: true,
            writeFiles: false,
            runCommands: false,
            unrestrictedNetwork: false,
          },
        },
        { principalId: CREATOR, userId: CREATOR },
      );
      if (created.kind !== 'created') throw new Error(`agent fixture failed: ${created.kind}`);
    }
    installTestDomains({
      agents: {
        agents,
        resolveWorkspace: () => Promise.resolve({ kind: 'workspace', workspaceId: WORKSPACE }),
      },
      // The home page reads the model connections best-effort; none are wired here.
      models: { kind: 'unavailable' },
    });
    installTestRunApi({
      authenticate: () => Promise.resolve(null),
      findAgent: () => Promise.resolve(null),
      openSession: () => Promise.resolve(null),
      ownsRun: () => Promise.resolve(false),
      store: new InMemoryRunStore(),
      launch: () => undefined,
      describeRunTarget: (_workspaceId, agentId) =>
        agentId === FAILING
          ? Promise.reject(new Error('the runtime profile store is unavailable'))
          : Promise.resolve({
              outsideProject: {
                kind: 'runnable',
                source: 'workspace',
                connectionId: 'c1',
                connectionName: 'anthropic default',
                provider: 'anthropic',
                model: 'claude-sonnet-4-5',
                runtimeProfileName: 'docker default',
              },
              byProject: new Map(),
            }),
    });
    const log = vi.spyOn(webLogger, 'error').mockImplementation(() => undefined);
    try {
      const home = await HomePage({ searchParams: Promise.resolve({}) });
      if (!isValidElement<ComponentProps<typeof HomeChat>>(home)) {
        throw new Error('HomePage did not return the HomeChat boundary');
      }
      const projection = home.props.agents;
      if (projection.kind !== 'agents') throw new Error(projection.reason);
      const byId = new Map(projection.agents.map((agent) => [agent.id, agent]));
      expect(byId.get(FAILING)?.runTarget).toEqual({ kind: 'unknown' });
      expect(byId.get(HEALTHY)?.runTarget).toEqual({
        kind: 'runnable',
        source: 'workspace',
        connectionName: 'anthropic default',
        model: 'claude-sonnet-4-5',
      });
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
