import { CONTROLLED_ENV, startModelListServer } from './api-key-quickstart.transport.test-support';
import crypto from 'node:crypto';
import { type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import {
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import type { RegisteredComposition } from './register';

import {
  seedQuickstartKeys,
  configureQuickstart,
  prepareQuickstartModel,
  installQuickstartRunDelivery,
  createQuickstartAgents,
} from './api-key-quickstart.bootstrap.test-support';
export function createApiKeyQuickstartFixture(env: NodeJS.ProcessEnv) {
  let isolated: IsolatedTestDatabase | undefined;
  let composition: RegisteredComposition | undefined;
  let modelListServer: Server | undefined;
  const previousEnv = new Map<string, string | undefined>();
  const keys = new Map<string, { readonly presented: string; readonly id: string }>();
  let builderAgentId = '';
  let ownerAgentId = '';
  let fixtureWorkspaceId = '';
  let fixtureConnectionId = '';
  function key(name: string): string {
    const found = keys.get(name);
    if (found === undefined) throw new Error(`no fixture key ${name}`);
    return found.presented;
  }
  beforeAll(async () => {
    for (const name of CONTROLLED_ENV) previousEnv.set(name, env[name]);

    isolated = await createIsolatedTestDatabase('aw_api_key_quickstart');

    const workspaceId = crypto.randomUUID();

    fixtureWorkspaceId = workspaceId;

    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: 'api-key-quickstart',
      name: 'API-key quickstart',
    });
    await seedQuickstartKeys(isolated, workspaceId, keys);
    composition = await configureQuickstart(env, isolated.url);

    // What `runs.start` needs before it queues a run (issue #393): a runtime profile on the agent
    // and a ready model connection whose model list offers the agent's model.
    const modelList = await startModelListServer();

    modelListServer = modelList.server;
    const runnable = await prepareQuickstartModel(isolated, workspaceId, modelList.url);
    fixtureConnectionId = runnable.modelConnectionId;
    installQuickstartRunDelivery();
    const created = await createQuickstartAgents(key, runnable);

    [builderAgentId = '', ownerAgentId = ''] = created;
  }, 180_000);
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    if (modelListServer !== undefined) {
      const server = modelListServer;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (isolated !== undefined) {
      await closeIsolatedTestResources(
        isolated,
        ...(composition === undefined ? [] : [composition]),
      );
    }
  });
  return {
    get env() {
      return env;
    },
    get isolated() {
      return isolated;
    },
    get composition() {
      return composition;
    },
    get modelListServer() {
      return modelListServer;
    },
    get previousEnv() {
      return previousEnv;
    },
    get keys() {
      return keys;
    },
    get builderAgentId() {
      return builderAgentId;
    },
    get ownerAgentId() {
      return ownerAgentId;
    },
    get fixtureWorkspaceId() {
      return fixtureWorkspaceId;
    },
    get fixtureConnectionId() {
      return fixtureConnectionId;
    },
    get key() {
      return key;
    },
  };
}

export type ApiKeyQuickstartFixture = ReturnType<typeof createApiKeyQuickstartFixture>;
