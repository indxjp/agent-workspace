/**
 * Shared setup for the Builder provisioning integration tests: the isolated database and the
 * environment the production composition reads, workspace and Builder fixtures, and the model-list
 * stand-in and run-start preflight used by the "provisioned before setup" tests.
 */
import crypto from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { and, count, eq, isNotNull } from 'drizzle-orm';
import { afterEach } from 'vitest';

import { BUILDER_MODEL } from '@indx-workspace/contracts/builder';
import {
  agents,
  agentVersions,
  auditEvents,
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  runtimeProfiles,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';

import { applicationContext, clearApplicationContext } from '../application-context';
import { resetTestRunApi } from '../application-context-fixtures';
import { getRunApi } from '../runs/environment';
import type { RegisteredComposition } from './register';

const CONTROLLED_ENV = [
  'AW_DEPLOYMENT_FEATURES',
  'AW_STORAGE_URL',
  'BOOTSTRAP_ADMIN',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'WORKSPACE_SLUG',
  'DATABASE_URL',
  'GATEWAY_TOKEN_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'NEXT_RUNTIME',
  'RUNNER_MANAGER_TOKEN',
  'RUNNER_MANAGER_URL',
  'RUNNER_URL',
  'SESSION_SECRET',
] as const;

export type TestDb = IsolatedTestDatabase['db'];

/** A workspace with one Owner membership and its principal. */
export interface TestWorkspace {
  readonly id: string;
  readonly principalId: string;
  readonly userId: string;
}

export interface CompositionHarness {
  /** The composition a test started; closed after the test. */
  composition: RegisteredComposition | undefined;
  start(): Promise<IsolatedTestDatabase>;
}

/** Register the per-test environment and database clean-up; call inside a `describe`. */
export function useCompositionHarness(): CompositionHarness {
  let isolated: IsolatedTestDatabase | undefined;
  const previousEnv = new Map<string, string | undefined>();
  const harness: CompositionHarness = {
    composition: undefined,
    async start() {
      for (const key of CONTROLLED_ENV) previousEnv.set(key, process.env[key]);
      for (const key of CONTROLLED_ENV) delete process.env[key];
      isolated = await createIsolatedTestDatabase('aw_composition_builder_provisioning');
      process.env['DATABASE_URL'] = isolated.url;
      process.env['SESSION_SECRET'] = 'composition-builder-test-secret-at-least-32-characters';
      return isolated;
    },
  };

  afterEach(async () => {
    for (const key of CONTROLLED_ENV) {
      const value = previousEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previousEnv.clear();
    clearApplicationContext();
    resetTestRunApi();
    if (isolated !== undefined) {
      await closeIsolatedTestResources(
        isolated,
        ...(harness.composition === undefined ? [] : [harness.composition]),
      );
    }
    isolated = undefined;
    harness.composition = undefined;
  });

  return harness;
}

export async function createOwnedWorkspace(db: TestDb, slug: string): Promise<TestWorkspace> {
  const id = crypto.randomUUID();
  const userId = crypto.randomUUID();
  const membershipId = crypto.randomUUID();
  const principalId = crypto.randomUUID();
  await db.insert(workspaces).values({ id, slug, name: slug });
  await db.insert(users).values({ id: userId, email: `${userId}@example.test`, name: slug });
  await db.transaction(async (tx) => {
    await tx
      .insert(memberships)
      .values({ id: membershipId, workspaceId: id, userId, role: 'owner' });
    await tx
      .insert(workspacePrincipals)
      .values({ id: principalId, workspaceId: id, kind: 'membership', membershipId });
  });
  return { id, principalId, userId };
}

export async function builders(db: TestDb, workspaceId: string) {
  return db
    .select({ id: agents.id, builtinKey: agents.builtinKey })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), isNotNull(agents.builtinKey)));
}

export function installed() {
  const application = applicationContext();
  if (application === null) throw new Error('the composition installed no application context');
  return application;
}

export async function auditCount(db: TestDb, workspaceId: string) {
  const [row] = await db
    .select({ total: count() })
    .from(auditEvents)
    .where(eq(auditEvents.workspaceId, workspaceId));
  return row?.total ?? 0;
}

/** A loopback stand-in for the provider's model list, offering the Builder's pinned model. */
export async function modelList(): Promise<{ readonly baseUrl: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url?.startsWith('/v1/models') === true) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ data: [{ id: BUILDER_MODEL, type: 'model' }], has_more: false }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function builderRow(db: TestDb, workspaceId: string) {
  const [row] = await db
    .select({
      id: agents.id,
      modelConnectionId: agents.modelConnectionId,
      runtimeProfileId: agents.runtimeProfileId,
    })
    .from(agents)
    .where(and(eq(agents.workspaceId, workspaceId), isNotNull(agents.builtinKey)));
  if (row === undefined) throw new Error('the workspace has no Builder');
  return row;
}

export async function versionIds(db: TestDb, agentId: string) {
  const rows = await db
    .select({ id: agentVersions.id })
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentId));
  return rows.map((row) => row.id);
}

/** The workspace default runtime profile, as setup leaves it. */
export async function setupProfile(db: TestDb, workspaceId: string) {
  const [profile] = await db
    .insert(runtimeProfiles)
    .values({
      workspaceId,
      name: 'setup-local',
      driver: 'local',
      networkPolicy: 'none',
      filesystem: 'read-only',
      workspaceDefault: true,
    })
    .returning({ id: runtimeProfiles.id });
  if (profile === undefined) throw new Error('the runtime profile was not written');
  return profile.id;
}

/** Create a model connection through the models API the routes use. */
export async function connection(workspaceId: string, name: string, baseUrl: string) {
  const api = installed().models;
  if (api.kind !== 'serving') throw new Error('the composition installed no models API');
  const created = await api.runtime.models.forWorkspace(workspaceId).create({
    name,
    provider: 'anthropic',
    apiKey: 'sk-ant-builder-before-setup',
    config: { baseUrl },
  });
  if (created.kind !== 'created') throw new Error(`model connection: ${created.kind}`);
  return created.connection.id;
}

/**
 * The run-start preflight's refusal code for the Builder: for a new session (no `versionId`, the
 * row) or a turn of a session pinned to version `versionId`.
 */
export async function preflightCode(ws: TestWorkspace, agentId: string, versionId?: string) {
  const runApi = getRunApi();
  if (runApi?.preflight === undefined) throw new Error('the composition installed no preflight');
  const principal = {
    principalId: ws.principalId,
    ownerPrincipalId: ws.principalId,
    userId: ws.userId,
    workspaceId: ws.id,
    role: 'owner' as const,
    scope: null,
  };
  const agent = await runApi.findAgent(principal, agentId);
  if (agent === null) throw new Error('the run API does not find the Builder');
  return (await runApi.preflight(principal, agent, null, null, versionId))?.code;
}
