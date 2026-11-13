/** Isolated database, principals and lifecycle for the API-key route inventory. */
import crypto from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ApiRoute } from '@indx-workspace/contracts/routes';
import { MEMBERSHIP_ROLES } from '@indx-workspace/contracts/team';
import { afterAll, beforeAll } from 'vitest';
import {
  apiKeys,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  endpointClientAgents,
  endpointClients,
  mcpServers,
  runs as runRows,
  sessions as sessionRows,
  triggers,
  webhooks,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { encodeFileId } from '../files/file-id';
import { mintApiKey } from '../rbac/api-key';
import type { Role } from '../rbac/core/roles';
import { decide } from '../rbac/decide';
import { clearWebRuntimeRegistry, configureWebRuntimeRegistry } from '../runtimes/registry';
import {
  ownerCreates,
  SEEDED_FILE_PATH,
  SEEDED_RUN_ID,
  seedFile,
  serve,
} from './api-key-route-requests.test-support';
import type { RegisteredComposition } from './register';

export const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());

const CONTROLLED_ENV = [
  'AW_STORAGE_URL',
  'AW_RUNTIME_VERIFICATION_FILE',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'NEXT_RUNTIME',
  'RUNNER_MANAGER_TOKEN',
  'RUNNER_MANAGER_URL',
  'RUNNER_URL',
  'SESSION_SECRET',
] as const;

const UNSEEDED_ID = '00000000-0000-4000-8000-000000000000';

/** Shaped exactly like a minted key, so it is refused by the lookup and not by the parser. */
export const UNKNOWN_KEY = `ak_live_${'A'.repeat(22)}_${'B'.repeat(43)}`;

/**
 * Routes §21 denies a Viewer outright that nevertheless answer a Viewer by design, each with the
 * record that declares it. Exact `METHOD /path` keys; a stale entry fails the suite.
 */
export const VIEWER_EXCEPTIONS: Readonly<Record<string, string>> = {
  'GET /api/model-connections':
    'Declared gap G-12 (the Wave 9 plan, ADR W9-SEC-149): model-connection reads stay membership-scoped; only writes reach decide().',
  'GET /api/model-connections/:id': 'Declared gap G-12, as above.',
  'GET /api/models': 'Declared gap G-12, as above: the model catalogue is a model-connection read.',
};

/**
 * Routes that answer a refused caller `404` rather than `403`, by design, so as not to confirm that
 * a row outside the caller's reach exists. Exact keys; the refusal is still asserted, and the row
 * is checked to be unchanged afterwards.
 */
export const CONCEALS_REFUSAL_AS_404: Readonly<Record<string, string>> = {
  'POST /api/projects/:id/archive':
    'server/projects/lifecycle.ts maps the gate’s 403 to project_not_found: "is there such a project" gets one answer.',
  'POST /api/projects/:id/restore': 'The same transition path as archive, above.',
};

/**
 * Whether §21 refuses a Viewer this route even when the row is its own — the routes an Owner or
 * Admin (or a Builder) must hold. Read from the table itself rather than restated, so a change to
 * §21 moves the expectation with it.
 */
export function deniedToViewerOutright(route: ApiRoute, concrete: string): boolean {
  const verdict = decide({
    role: 'viewer',
    method: route.method,
    path: concrete,
    ownership: 'own',
    scope: null,
  });
  return verdict.effect === 'deny';
}

interface InventoryState {
  isolated: IsolatedTestDatabase | undefined;
  composition: RegisteredComposition | undefined;
  storageRoot: string | undefined;
  readonly previousEnv: Map<string, string | undefined>;
  readonly keys: Map<Role, string>;
  readonly seeded: Map<string, string>;
  readonly registryCalls: unknown[][];
}

export function useRouteInventory() {
  const state: InventoryState = {
    isolated: undefined,
    composition: undefined,
    storageRoot: undefined,
    previousEnv: new Map(),
    keys: new Map(),
    seeded: new Map(),
    registryCalls: [],
  };
  beforeAll(() => initializeInventory(state), 180_000);
  afterAll(() => disposeInventory(state));
  return {
    keys: state.keys,
    registryCalls: state.registryCalls,
    serve: (route: ApiRoute, concrete: string, apiKey: string) => serve(route, concrete, apiKey),
    concretePath: (route: ApiRoute) => concretePath(state, route),
    database: () => state.isolated,
  };
}

async function initializeInventory(state: InventoryState) {
  for (const name of CONTROLLED_ENV) state.previousEnv.set(name, process.env[name]);
  state.isolated = await createIsolatedTestDatabase('aw_api_key_route_inventory');
  const workspaceId = crypto.randomUUID();
  await state.isolated.db.insert(workspaces).values({
    id: workspaceId,
    slug: 'api-key-route-inventory',
    name: 'API-key route inventory',
  });
  let ownerKeyId = '';
  for (const role of MEMBERSHIP_ROLES) {
    const minted = await mintApiKey();
    const apiKeyId = crypto.randomUUID();
    if (role === 'owner') ownerKeyId = apiKeyId;
    await state.isolated.db.insert(apiKeys).values({
      id: apiKeyId,
      workspaceId,
      name: `inventory-${role}`,
      role,
      keyPrefix: minted.keyPrefix,
      keyHash: minted.keyHash,
    });
    state.keys.set(role, minted.presented);
  }

  state.storageRoot = await mkdtemp(path.join(os.tmpdir(), 'aw-key-inventory-'));
  process.env['DATABASE_URL'] = state.isolated.url;
  process.env['SESSION_SECRET'] = 'api-key-route-inventory-secret-at-least-32-characters';
  process.env['MASTER_ENCRYPTION_KEY'] = crypto.randomBytes(32).toString('hex');
  process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
  process.env['AW_STORAGE_URL'] = pathToFileURL(state.storageRoot).href;
  for (const name of [
    'AW_RUNTIME_VERIFICATION_FILE',
    'GATEWAY_TOKEN_SECRET',
    'NEXT_RUNTIME',
    'RUNNER_MANAGER_TOKEN',
    'RUNNER_MANAGER_URL',
  ] as const) {
    delete process.env[name];
  }
  const { register } = await import('./register');
  state.composition = await register();
  if (state.composition === undefined) throw new Error('composition registration was skipped');

  // `POST /api/runtimes/test` starts a sandbox through this registry; recording it proves that
  // no refused request ever reaches it, rather than inferring it from a status code.
  configureWebRuntimeRegistry({
    list: () => Promise.resolve([]),
    test(driverId, echo) {
      state.registryCalls.push([driverId, echo]);
      return Promise.resolve({ driverId, transcript: [echo], destroyed: true });
    },
  });

  await seedOwnedCollections(state);
  await seedFile(state.keys.get('owner') ?? '');
  await seedPrincipalRows(state, workspaceId, ownerKeyId);
}

async function disposeInventory(state: InventoryState) {
  clearWebRuntimeRegistry();
  for (const [name, value] of state.previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (state.isolated !== undefined) {
    await closeIsolatedTestResources(
      state.isolated,
      ...(state.composition === undefined ? [] : [state.composition]),
    );
  }
  if (state.storageRoot !== undefined)
    await rm(state.storageRoot, { recursive: true, force: true });
}

function concretePath(state: InventoryState, route: ApiRoute): string {
  return route.path.replace(/:([A-Za-z]+)/gu, (_match, name: string, offset: number) => {
    if (route.path.startsWith('/api/runtimes/')) return 'test';
    if (route.path.startsWith('/api/files/')) return encodeFileId(SEEDED_FILE_PATH);
    const prefix = route.path.slice(0, offset - 1);
    const row = state.seeded.get(prefix);
    if (row !== undefined) return row;
    return name === 'name' ? 'no-such-skill' : UNSEEDED_ID;
  });
}

async function seedOwnedCollections(state: InventoryState) {
  // Rows the Viewer probes address, created through the routes by the Owner key: a refusal on
  // an item route must be a refusal, not a `404` for a row that was never there.
  state.seeded.set(
    '/api/secrets',
    await ownerCreates(state.keys.get('owner') ?? '', '/api/secrets', {
      name: 'INVENTORY_KEY',
      value: 'v',
    }),
  );
  state.seeded.set(
    '/api/runtime-profiles',
    await ownerCreates(state.keys.get('owner') ?? '', '/api/runtime-profiles', {
      name: 'Inventory',
      driver: 'docker',
      networkPolicy: 'restricted',
      allowedDomains: ['api.anthropic.com'],
      filesystem: 'read-write',
      cpu: 1,
      memoryMb: 1024,
    }),
  );
  state.seeded.set(
    '/api/agents',
    await ownerCreates(state.keys.get('owner') ?? '', '/api/agents', {
      name: 'Inventory agent',
      instructions: 'Seeded by the API-key route inventory.',
      modelConnectionId: null,
      model: 'claude-sonnet-4-5',
      permissions: {
        readFiles: true,
        writeFiles: false,
        runCommands: false,
        unrestrictedNetwork: false,
      },
    }),
  );
  state.seeded.set(
    '/api/projects',
    await ownerCreates(state.keys.get('owner') ?? '', '/api/projects', {
      name: 'Inventory project',
      instructions: null,
      defaultAgentId: null,
      visibility: 'private',
      fileIds: [],
      mcpServerIds: [],
    }),
  );
}

async function seedPrincipalRows(state: InventoryState, workspaceId: string, ownerKeyId: string) {
  if (state.isolated === undefined) throw new Error('inventory database has not been initialized');
  // An API key cannot create a connector through the route (a connector is attributed to a
  // member, and a key has none), so the Owner key's principal owns one inserted directly.
  const ownerKeyPrincipal = (await state.isolated.db.select().from(workspacePrincipals)).find(
    (principal) => principal.workspaceId === workspaceId && principal.apiKeyId === ownerKeyId,
  );
  if (ownerKeyPrincipal === undefined) throw new Error('the Owner key has no principal');
  const connectorId = crypto.randomUUID();
  await state.isolated.db.insert(mcpServers).values({
    id: connectorId,
    workspaceId,
    name: 'Inventory connector',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
    ownerPrincipalId: ownerKeyPrincipal.id,
  });
  state.seeded.set('/api/connectors', connectorId);
  const agentId = state.seeded.get('/api/agents');
  if (agentId === undefined) throw new Error('the agent was not seeded');
  // A key cannot create an endpoint client (it acts for no member), so the row the Viewer
  // probes address is inserted directly, as the connector above is.
  const endpointClientId = crypto.randomUUID();
  await state.isolated.db.insert(endpointClients).values({
    id: endpointClientId,
    workspaceId,
    name: 'inventory-client',
    kind: 'a2a-agent',
    actsForPrincipalId: ownerKeyPrincipal.id,
    createdByPrincipalId: ownerKeyPrincipal.id,
  });
  await state.isolated.db
    .insert(endpointClientAgents)
    .values({ clientId: endpointClientId, workspaceId, agentId });
  state.seeded.set('/api/endpoint-clients', endpointClientId);
  // A key cannot create a trigger either (it is owned by a member), so the row is inserted
  // directly for the Viewer probes to address.
  const triggerId = crypto.randomUUID();
  await state.isolated.db.insert(triggers).values({
    id: triggerId,
    workspaceId,
    agentId,
    name: 'inventory-trigger',
    kind: 'webhook',
    promptTemplate: 'Handle {{body}}',
    ownerPrincipalId: ownerKeyPrincipal.id,
    secretHash: '0'.repeat(64),
  });
  state.seeded.set('/api/triggers', triggerId);
  // A webhook is inserted directly too, so the Viewer's DELETE probe addresses a real row and
  // its 403 cannot be a 404 standing in for the refusal (N-3, issue #250).
  const webhookId = crypto.randomUUID();
  await state.isolated.db.insert(webhooks).values({
    id: webhookId,
    workspaceId,
    url: 'https://hooks.example.com/inventory',
    events: ['run.completed'],
  });
  state.seeded.set('/api/webhooks', webhookId);
  // An agent team the Owner key creates, so the Viewer's DELETE and version probes address a
  // real team and their 403 cannot be a 404 (ADR-0104 acceptance, issue #1516).
  state.seeded.set(
    '/api/agent-teams',
    await ownerCreates(state.keys.get('owner') ?? '', '/api/agent-teams', {
      name: 'Inventory team',
    }),
  );
  const sessionId = crypto.randomUUID();
  await state.isolated.db.insert(sessionRows).values({
    id: sessionId,
    workspaceId,
    userId: null,
    ownerPrincipalId: ownerKeyPrincipal.id,
    agentId,
  });
  await state.isolated.db.insert(runRows).values({ id: SEEDED_RUN_ID, workspaceId, sessionId });
}

export { label, moduleKey, ROUTE_MODULES } from './api-key-route-requests.test-support';

export { KEY_ROUTES } from './api-key-route-requests.test-support';
