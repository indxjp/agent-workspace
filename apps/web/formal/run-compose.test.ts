import crypto from 'node:crypto';

import type { AgentPermissions } from '@agent-workspace/core';
import { openDatabaseRoot, type DatabaseRoot } from '@agent-workspace/core/db';
import {
  closeIsolatedTestResources,
  createIsolatedTestDatabase,
  memberships,
  users,
  workspacePrincipals,
  workspaces,
  type IsolatedTestDatabase,
} from '@agent-workspace/core/db/unscoped';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AgentRecord } from '../server/agents/contract';
import {
  applyFileGrantPolicy,
  portableAgentConfigFor,
  resolveModelForRun,
  sandboxFor,
} from '../server/compose/run-request';
import { createInMemoryModelsStoreProvider } from '../server/models/memory-store';
import { parseStartRunBody } from '../server/runs/api';
import { asRecord, asString, loadVectors } from '../../../tests/formal/vectors';
import type { RegisteredComposition } from '../server/composition/register';

const FAMILY = 'run-compose';
const parserVectors = loadVectors(FAMILY, 'parser.json');
const sessionVectors = loadVectors(FAMILY, 'session.json');
const sandboxVectors = loadVectors(FAMILY, 'sandbox.json');

function rejectionCategory(reason: string, input: unknown): string {
  if (reason.includes('must be a JSON object')) return 'not-object';
  if (reason.startsWith('unknown field')) return 'unknown-key';
  if (reason.includes('"prompt" is required')) return 'prompt-type';
  if (reason.includes('"prompt" must not be empty')) return 'prompt-blank';
  if (reason.includes('the maximum is')) return 'prompt-long';
  if (reason.includes('"modelConnectionId" and "model"')) return 'model-pair';
  if (reason.includes('"modelConnectionId" must')) return 'connection-id';
  if (
    reason.includes('"model" must be a non-empty string') &&
    typeof input === 'object' &&
    input !== null &&
    'model' in input &&
    input.model === ''
  )
    return 'model-blank';
  if (reason.includes('"model" must')) return 'model-type';
  if (reason.includes('"sessionId" must')) return 'session-id';
  throw new Error(`unclassified start-body refusal: ${reason}`);
}

describe('run-compose: server start-body parser', () => {
  it.each(parserVectors)('$id', ({ id, input, expected }) => {
    const result = parseStartRunBody(input);
    const category = result.kind === 'ok' ? 'ok' : rejectionCategory(result.reason, input);
    expect(category).toBe(asString(asRecord(expected, id)['result'], 'result'));
  });
});

/**
 * The permission-derived tool denials moved (ENG-04b, #325).
 *
 * `tools.json` is replayed by `tests/formal/run-compose.test.ts` now, against the Claude adapter's
 * own `compileClaudeToolPolicy`. It is the same vector file, unedited, and that is the point: the
 * mapping is the same mapping, in a different package. Decision D-012 puts a replay that imports a
 * *package* under `tests/formal/` and one that imports *application* code here, so the file follows
 * the code it is about.
 */

describe('run-compose: sandbox scope', () => {
  it.each(sandboxVectors)('$id', ({ id, input, expected }) => {
    const sessionId = asString(asRecord(input, id)['sessionId'], 'sessionId');
    const result = asRecord(expected, id)['result'];
    if (result === null) {
      expect(() =>
        sandboxFor('workspace-a', sessionId, {
          workspaceRoot: '/workspace',
          runnerUrl: 'http://localhost:9',
        }),
      ).toThrow(/not safe to use as a path segment/u);
    } else {
      // The vector's third field, `configDir`, is the *engine's* answer since ENG-04b (#325) and is
      // replayed against the Claude adapter in `tests/formal/run-compose.test.ts`. Compose composes
      // the two halves that are the platform's: the sandbox root and the tenant namespace.
      expect(
        sandboxFor('workspace-a', sessionId, {
          workspaceRoot: '/workspace',
          runnerUrl: 'http://localhost:9',
        }),
      ).toEqual({
        cwd: asRecord(result, id)['cwd'],
        projectKey: asRecord(result, id)['projectKey'],
      });
    }
  });
});

describe('run-compose: real narrowing decisions', () => {
  const agent: AgentRecord = {
    id: '55555555-5555-4555-8555-555555555555',
    workspaceId: 'workspace-a',
    name: 'Formal Compose',
    instructions: '',
    modelConnectionId: null,
    model: null,
    runtimeProfileId: null,
    permissions: {
      readFiles: true,
      writeFiles: true,
      runCommands: true,
      unrestrictedNetwork: true,
    },
    policy: {
      engine: 'claude-agent-sdk',
      tools: {
        base: 'claude_code_preset',
        autoApprove: [],
        deny: ['WebFetch'],
        permissionMode: 'default',
        allowDangerouslySkipPermissions: false,
      },
      skills: { mode: 'allowlist', names: ['assigned', 'unassigned'] },
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    createdBy: null,
    ownerPrincipalId: '77777777-7777-4777-8777-777777777777',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  };

  it('preserves stored denials and intersects requested skills with assignment', () => {
    const config = portableAgentConfigFor(agent, undefined, null, {
      files: [],
      skills: [{ name: 'assigned', files: [{ path: 'SKILL.md', contentBase64: '' }] }],
      mcpServers: {},
    });
    expect(config.skills).toEqual({ mode: 'allowlist', names: ['assigned'] });
  });

  it('denies KillShell for a read-only file grant', () => {
    // The compose-side guard, which since ENG-04b answers the denial list rather than editing a
    // Claude-shaped agent configuration. The adapter derives the same list and de-duplicates.
    const deny = applyFileGrantPolicy('/workspace/w/s', [
      { kind: 'file', path: 'readme.txt', access: 'read', contentBase64: '' },
    ]);
    expect(deny).toContain('KillShell');
    expect(deny).toContain('Edit(//workspace/w/s/readme.txt)');
  });

  it('refuses an unreadable run connection without falling back', async () => {
    const store = createInMemoryModelsStoreProvider(['workspace-a']).forWorkspace('workspace-a');
    const run = await store.create({
      name: 'Run',
      provider: 'anthropic',
      apiKey: 'sk-run',
      config: {},
    });
    const workspace = await store.create({
      name: 'Workspace',
      provider: 'anthropic',
      apiKey: 'sk-workspace',
      config: {},
    });
    if (run.kind !== 'created' || workspace.kind !== 'created')
      throw new Error('model fixture failed');
    const unreadable = { ...store, resolve: () => Promise.resolve(null) };
    const resolution = await resolveModelForRun(
      {
        run: { connectionId: run.connection.id, model: 'run-model' },
        agent: null,
        project: null,
        workspace: { connectionId: workspace.connection.id, model: 'workspace-model' },
        deployment: null,
      },
      unreadable,
      () => {
        throw new Error('discovery must not run');
      },
    );
    expect(resolution).toMatchObject({ ok: false, layer: 'run' });
  });

  // model_resolution_deployment_is_last / _applies / _unconfigured_refused (issue #506).
  it('tries the deployment default last, and refuses an unconfigured one at that layer', async () => {
    const store = createInMemoryModelsStoreProvider(['workspace-a']).forWorkspace('workspace-a');
    const created = await store.create({
      name: 'default',
      provider: 'anthropic',
      apiKey: 'sk-default',
      config: {},
    });
    if (created.kind !== 'created') throw new Error('model fixture failed');
    const connectionId = created.connection.id;
    const discover = () =>
      Promise.resolve({
        ok: true as const,
        stale: false,
        models: ['claude-sonnet-4-5', 'workspace-model'].map((providerModelId) => ({
          connectionId,
          providerModelId,
          displayName: providerModelId,
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
        })),
      });
    const none = { run: null, agent: null, project: null, workspace: null };
    const configured = { connectionId, defaults: { anthropic: 'claude-sonnet-4-5' } };

    await expect(
      resolveModelForRun(
        { ...none, workspace: { connectionId, model: 'workspace-model' }, deployment: configured },
        store,
        discover,
      ),
    ).resolves.toMatchObject({ ok: true, layer: 'workspace', model: 'workspace-model' });
    await expect(
      resolveModelForRun({ ...none, deployment: configured }, store, discover),
    ).resolves.toMatchObject({ ok: true, layer: 'deployment', model: 'claude-sonnet-4-5' });
    await expect(
      resolveModelForRun({ ...none, deployment: { connectionId, defaults: {} } }, store, discover),
    ).resolves.toMatchObject({ ok: false, layer: 'deployment' });
    // No connection of the agent's and none named `default`: a connection that does not exist.
    await expect(
      resolveModelForRun(
        { ...none, deployment: { connectionId: null, defaults: configured.defaults } },
        store,
        discover,
      ),
    ).resolves.toMatchObject({ ok: false, layer: 'deployment' });
    await expect(
      resolveModelForRun({ ...none, deployment: null }, store, discover),
    ).resolves.toMatchObject({ ok: false, layer: 'workspace' });
  });
});

const hasDatabase = Boolean(process.env['TEST_DATABASE_URL']?.trim());
const CONTROLLED_ENV = ['DATABASE_URL', 'SESSION_SECRET', 'RUNNER_URL', 'NEXT_RUNTIME'] as const;

describe.skipIf(!hasDatabase)('run-compose: real openSession composition', () => {
  let isolated: IsolatedTestDatabase;
  let root: DatabaseRoot;
  let composition: RegisteredComposition;
  let agentId: string;
  let workspaceId: string;
  let ownerId: string;
  let principalId: string;
  let previousEnv: Record<(typeof CONTROLLED_ENV)[number], string | undefined>;

  beforeAll(async () => {
    isolated = await createIsolatedTestDatabase('aw_formal_run_compose');
    workspaceId = crypto.randomUUID();
    ownerId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    principalId = crypto.randomUUID();
    await isolated.db.insert(workspaces).values({
      id: workspaceId,
      slug: workspaceId,
      name: 'Formal Compose',
    });
    await isolated.db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.com`,
      name: 'Owner',
    });
    await isolated.db.transaction(async (tx) => {
      await tx.insert(memberships).values({
        id: membershipId,
        workspaceId,
        userId: ownerId,
        role: 'owner',
      });
      await tx.insert(workspacePrincipals).values({
        id: principalId,
        workspaceId,
        kind: 'membership',
        membershipId,
      });
    });
    root = await openDatabaseRoot({ DATABASE_URL: isolated.url });
    const scope = await root.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('scope resolution failed');
    const permissions: AgentPermissions = {
      readFiles: true,
      writeFiles: false,
      runCommands: false,
      unrestrictedNetwork: false,
    };
    const created = await root.agents.forScope(scope).create({
      name: 'Compose agent',
      instructions: 'fixture',
      modelConnectionId: null,
      model: null,
      permissions,
      createdBy: ownerId,
      ownerPrincipalId: principalId,
    });
    if (created.kind !== 'created') throw new Error(`agent seed failed: ${created.kind}`);
    agentId = created.agent.id;
    previousEnv = Object.fromEntries(
      CONTROLLED_ENV.map((key) => [key, process.env[key]]),
    ) as typeof previousEnv;
    process.env['DATABASE_URL'] = isolated.url;
    process.env['SESSION_SECRET'] = 'formal-run-compose-session-secret-at-least-32-bytes';
    process.env['RUNNER_URL'] = 'http://127.0.0.1:9';
    delete process.env['NEXT_RUNTIME'];
    const { register } = await import('../server/composition/register');
    const registered = await register();
    if (registered === undefined) throw new Error('register returned no composition');
    composition = registered;
  }, 180_000);

  afterAll(async () => {
    for (const key of CONTROLLED_ENV) {
      const prior = previousEnv[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    await closeIsolatedTestResources(isolated, composition, root);
  });

  it('refuses an archived session before its SDK id can select resume', async () => {
    const archivedVector = sessionVectors.find((vector) => vector.id === 'archived');
    if (archivedVector === undefined) throw new Error('missing archived-session vector');
    const expected = asRecord(archivedVector.expected, 'archived');
    const { getRunApi } = await import('../server/runs/environment');
    const api = getRunApi();
    if (api === null) throw new Error('run API was not installed');
    const scope = await root.scopes.forWorkspaceId(workspaceId);
    if (scope === null) throw new Error('scope resolution failed');
    const principal = {
      principalId,
      ownerPrincipalId: principalId,
      userId: ownerId,
      workspaceId,
      role: 'owner' as const,
      scope: null,
    };
    const agent = { id: agentId, workspaceId, engine: 'claude-agent-sdk' };
    const created = await api.openSession(principal, agent, null);
    if (created === null) throw new Error('session was not created');
    const recorded = await root.sessions.forScope(scope).update(created.id, {
      engineIdentity: { engineSessionId: created.id, engine: 'claude-agent-sdk' },
    });
    expect(recorded.kind).toBe('updated');
    await root.sessions.forScope(scope).archive(created.id);
    const reopened = await api.openSession(principal, agent, created.id);
    expect(reopened !== null).toBe(expected['current']);
    expect(expected['target']).toBe(false);
    expect(reopened).toBeNull();
    expect(expected['resume']).toBe(true);
    const otherPrincipalId = crypto.randomUUID();
    const otherOwner = await api.openSession(
      { ...principal, principalId: otherPrincipalId, ownerPrincipalId: otherPrincipalId },
      agent,
      created.id,
    );
    expect(otherOwner).toBeNull();
  }, 180_000);
});
