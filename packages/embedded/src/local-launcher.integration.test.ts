import { createLocalAgent, localApiKeys } from './launcher-api.test-support.js';
import { RuntimeTestProject } from './launcher-project.test-support.js';
/**
 * The published launcher uses real services and IPC. These scenarios intentionally share a
 * project: they prove credentials, runtime defaults, ownership and secrets survive a restart.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { connect, readDatabaseConfig } from '@agent-workspace/core/db/unscoped';
import { CONTRACTS_VERSION } from '@indx-workspace/contracts';
import { API_KEY_PATTERN } from '@indx-workspace/contracts/api-keys';
import { ModelConnectionListResponseSchema } from '@indx-workspace/contracts/models';
import { SurfaceSessionResponseSchema } from '@indx-workspace/contracts/surfaces';
import { MeResponseSchema } from '@indx-workspace/contracts/team';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  DEFAULT_DATABASE_PORT,
  EMBEDDED_DATABASE_URL,
  LOCAL_ANTHROPIC_DEFAULT_MODEL,
  LocalSecretsFileSchema,
  RUNTIME_RESOLUTION_FAILURES,
  RUN_TIMEOUT_MS,
  UNREACHABLE_MODEL_BASE_URL,
  agentFromVersion,
  authorised,
  bootstrapAdminPrincipalId,
  getAgentOwner,
  getAgentProfileId,
  getMe,
  getModelConnections,
  listRuntimeProfiles,
  openSurfaceSession,
  runPastResolution,
  startRun,
} from './launcher-api.test-support.js';
import { DATABASE_PORT } from './launcher-ports.test-support.js';
import {
  START_TIMEOUT_MS,
  STOP_TIMEOUT_MS,
  expectNoUncleanStopOutput,
  readPostmasterPort,
} from './launcher-process.test-support.js';

const project = new RuntimeTestProject('embedded-launcher-');
const firstSession: {
  token: string;
  url: string;
  workspaceId: string;
  stoppedAt: Date | undefined;
} = {
  token: '',
  url: '',
  workspaceId: '',
  stoppedAt: undefined,
};
const agents = {
  runtimeProfileId: '',
  currentId: '',
  earlyId: '',
  surfaceId: '',
  ownerPrincipalId: '',
};
const storedSecrets: { contents: Buffer | null; password: string } = {
  contents: null,
  password: '',
};

beforeAll(() => project.prepare());
afterAll(() => project.close(), STOP_TIMEOUT_MS);

it(
  'answers start with ready, then a workspace API key that /api/me and /api/model-connections accept',
  async () => {
    const { ready, credential } = await project.start();

    expect(ready.url).toBe(`http://127.0.0.1:${String(project.ports.web)}`);
    // The database is on this file's own port, never the default every other runtime shares.
    expect(readPostmasterPort(project.directory)).toBe(DATABASE_PORT);
    expect(DATABASE_PORT).not.toBe(DEFAULT_DATABASE_PORT);
    expect(ready.contractsVersion).toBe(CONTRACTS_VERSION);
    expect(credential.workspaceSlug).toBe('default');
    expect(Date.parse(credential.expiresAt)).toBeGreaterThan(Date.now());
    expect(credential.token).toMatch(API_KEY_PATTERN);
    firstSession.token = credential.token;
    firstSession.url = ready.url;
    firstSession.workspaceId = credential.workspaceId;

    const response = await getMe(ready.url, credential.token);
    expect(response.status).toBe(200);
    const me = MeResponseSchema.parse(await response.json());
    expect(me).toMatchObject({ kind: 'api-key', workspaceId: credential.workspaceId });
    expect((await getModelConnections(ready.url, credential.token)).status).toBe(200);
    // An admin key, but not one that can mint a key to outlive the run (S1-21).
    const child = await fetch(new URL('/api/api-keys', ready.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'persisted', role: 'admin' }),
    });
    expect(child.status).toBe(403);
  },
  START_TIMEOUT_MS + 30_000,
);

it('makes a local runtime profile on the local driver the workspace default (S1-22)', async () => {
  expect(firstSession.token).not.toBe('');
  const profiles = await listRuntimeProfiles(firstSession.url, firstSession.token);
  const local = profiles.filter((profile) => profile.name === 'local');
  expect(local).toHaveLength(1);
  expect(local[0]).toMatchObject({
    driver: 'local',
    networkPolicy: 'open',
    filesystem: 'read-write',
  });
  agents.runtimeProfileId = local[0]?.id ?? '';
  expect(agents.runtimeProfileId).not.toBe('');
});

it('stores a model: default agent pushed before any default connection with no connection (C7)', async () => {
  expect(agents.runtimeProfileId).not.toBe('');
  const { agent } = await createLocalAgent(
    firstSession,
    agentFromVersion('Early default model', { model: null, modelConnectionName: 'default' }),
  );
  // What `aw dev` without ANTHROPIC_API_KEY leaves behind: a restart that creates `default`
  // does not re-apply this unchanged version.
  expect(agent.modelConnectionId).toBeNull();
  expect(agent.model).toBeNull();
  agents.earlyId = agent.id;
});

it(
  'runs an agent whose version names no runtime profile on the local default: 202, past runtime resolution',
  async () => {
    expect(agents.runtimeProfileId).not.toBe('');
    // As `aw dev` does: the `default` connection, here on a model host nothing listens on.
    const connection = await fetch(
      new URL('/api/model-connections', firstSession.url),
      authorised(firstSession.token, {
        method: 'POST',
        body: JSON.stringify({
          name: 'default',
          provider: 'anthropic',
          apiKey: 'sk-ant-local-launcher-integration',
          config: { baseUrl: UNREACHABLE_MODEL_BASE_URL },
        }),
      }),
    );
    expect(connection.status).toBe(201);

    const { agent, version } = await createLocalAgent(firstSession, agentFromVersion());
    expect(version.body.definition.agent.runtimeProfileName).toBeNull();
    expect(agent.runtimeProfileId).toBe(agents.runtimeProfileId);
    agents.currentId = agent.id;

    const ended = await runPastResolution(firstSession.url, firstSession.token, agent.id);
    const [first] = project.runtimes;
    const logs = `${first?.stdout ?? ''}${first?.stderr ?? ''}`;
    for (const refusal of RUNTIME_RESOLUTION_FAILURES) {
      expect(ended.error ?? '', `the run's error names ${refusal}`).not.toContain(refusal);
      expect(logs, `the runtime's output names ${refusal}`).not.toContain(refusal);
    }
  },
  RUN_TIMEOUT_MS + 30_000,
);

it(
  'runs an agent that names the default connection but no model on the deployment default model (S1-23)',
  async () => {
    expect(agents.currentId).not.toBe('');
    // The `default` connection the previous test created, on a model host nothing listens on.
    const { agent } = await createLocalAgent(
      firstSession,
      agentFromVersion('Default model', { model: null, modelConnectionName: 'default' }),
    );
    expect(agent.modelConnectionId).not.toBeNull();
    expect(agent.model).toBeNull();
    expect(agent.runtimeProfileId).toBe(agents.runtimeProfileId);

    const ended = await runPastResolution(firstSession.url, firstSession.token, agent.id);
    expect(ended.model).toBe(LOCAL_ANTHROPIC_DEFAULT_MODEL);
    expect(ended.modelConnectionId).toBe(agent.modelConnectionId);
    for (const refusal of ['model_connection_unresolved', 'model_unavailable']) {
      expect(ended.error ?? '', `the run's error names ${refusal}`).not.toContain(refusal);
    }
  },
  RUN_TIMEOUT_MS + 30_000,
);

it(
  'runs the agent pushed before the default connection existed on that connection now (#506 review)',
  async () => {
    expect(agents.earlyId).not.toBe('');
    const connections = await fetch(
      new URL('/api/model-connections', firstSession.url),
      authorised(firstSession.token),
    );
    expect(connections.status).toBe(200);
    const listed = ModelConnectionListResponseSchema.parse(await connections.json());
    const defaultConnection = listed.models.find((entry) => entry.name === 'default');
    expect(defaultConnection).toBeDefined();

    const ended = await runPastResolution(firstSession.url, firstSession.token, agents.earlyId);
    expect(ended.model).toBe(LOCAL_ANTHROPIC_DEFAULT_MODEL);
    expect(ended.modelConnectionId).toBe(defaultConnection?.id);
    for (const refusal of ['model_connection_unresolved', 'model_unavailable']) {
      expect(ended.error ?? '', `the run's error names ${refusal}`).not.toContain(refusal);
    }
  },
  RUN_TIMEOUT_MS + 30_000,
);

it('pushes an agent with a surface main owned by the bootstrap admin, not the per-run key (S1-24)', async () => {
  expect(firstSession.token).not.toBe('');
  const { agent } = await createLocalAgent(
    firstSession,
    agentFromVersion('Front desk', undefined, ['main']),
  );
  agents.surfaceId = agent.id;
  agents.ownerPrincipalId = await bootstrapAdminPrincipalId(firstSession.workspaceId);
  expect(agent.ownerPrincipalId).toBe(agents.ownerPrincipalId);

  const opened = await openSurfaceSession(firstSession.url, 'main');
  const openedBody: unknown = await opened.json();
  expect(opened.status, JSON.stringify(openedBody)).toBe(201);
  expect(SurfaceSessionResponseSchema.parse(openedBody).agentId).toBe(agents.surfaceId);
});

it('refuses the run with 422 once the default is deleted, leaving the agent with no profile', async () => {
  expect(agents.currentId).not.toBe('');
  const deleted = await fetch(
    new URL(`/api/runtime-profiles/${agents.runtimeProfileId}`, firstSession.url),
    authorised(firstSession.token, { method: 'DELETE' }),
  );
  expect(deleted.status).toBe(204);
  expect(
    await getAgentProfileId(firstSession.url, firstSession.token, agents.currentId),
  ).toBeNull();
  const refused = await startRun(firstSession.url, firstSession.token, agents.currentId);
  const refusedBody = JSON.stringify(await refused.json());
  expect(refused.status, refusedBody).toBe(422);
  expect(refusedBody).toContain('agent_runtime_profile_missing');
});

it('writes .agent-workspace/.gitignore and an owner-only local-secrets.json', () => {
  expect(readFileSync(path.join(project.runtimeDirectory, '.gitignore'), 'utf8')).toBe('*\n');
  expect(existsSync(project.secretsFile)).toBe(true);
  if (process.platform !== 'win32') {
    expect(statSync(project.secretsFile).mode & 0o777).toBe(0o600);
  }
  storedSecrets.contents = readFileSync(project.secretsFile);
  storedSecrets.password = LocalSecretsFileSchema.parse(
    JSON.parse(storedSecrets.contents.toString('utf8')),
  ).BOOTSTRAP_ADMIN_PASSWORD;
});

it('prints where the generated password is kept, never the password (BH061-011)', () => {
  const [first] = project.runtimes;
  expect(storedSecrets.password).not.toBe('');
  expect(first?.stdout).toContain('local-secrets.json');
  expect(first?.stdout).not.toContain(storedSecrets.password);
});

it('leaves an agent owned by the first key itself, as a project pushed before S1-24 does', async () => {
  expect(agents.earlyId).not.toBe('');
  const live = (await localApiKeys(firstSession.workspaceId)).filter(
    (key) => key.revokedAt === null,
  );
  expect(live).toHaveLength(1);
  const firstKeyPrincipalId = live[0]?.principalId ?? '';
  expect(firstKeyPrincipalId).not.toBe('');
  // Raw SQL, so `updated_at` stays what `aw push` and the default-profile attach compare.
  const { pool } = connect(readDatabaseConfig({ DATABASE_URL: EMBEDDED_DATABASE_URL }));
  try {
    const updated = await pool.query(
      'update agents set owner_principal_id = $1 where workspace_id = $2 and id = $3',
      [firstKeyPrincipalId, firstSession.workspaceId, agents.earlyId],
    );
    expect(updated.rowCount).toBe(1);
  } finally {
    await pool.end();
  }
  expect(await getAgentOwner(firstSession.url, firstSession.token, agents.earlyId)).toBe(
    firstKeyPrincipalId,
  );
});

it(
  'exits 0 on SIGINT (on Windows, on the IPC channel closing)',
  async () => {
    const [first] = project.runtimes;
    expect(first).toBeDefined();
    // Only what the stop printed. Earlier tests ran agents whose model call cannot succeed, and a
    // run still in flight at the stop logs its own failure with a stack, so only the markers of
    // an unordered stop are checked here; the process-group test below checks for any stack.
    const before = first?.stderr.length ?? 0;
    const exit = await first?.interrupt();
    firstSession.stoppedAt = new Date();
    expect(exit).toStrictEqual({ code: 0, signal: null });
    expectNoUncleanStopOutput(first?.stderr.slice(before) ?? '');
  },
  STOP_TIMEOUT_MS + 10_000,
);

it(
  'restarts on the same secrets, prints only their path, and refuses the revoked key',
  async () => {
    expect(firstSession.token).not.toBe('');
    const { runtime, ready, credential } = await project.start();

    expect(readFileSync(project.secretsFile)).toStrictEqual(storedSecrets.contents);
    expect(runtime.stdout).toContain('local-secrets.json');
    expect(runtime.stdout).not.toContain(storedSecrets.password);
    expect(credential.token).not.toBe(firstSession.token);

    expect(credential.token).toMatch(API_KEY_PATTERN);
    expect((await getMe(ready.url, firstSession.token)).status).toBe(401);
    expect((await getModelConnections(ready.url, firstSession.token)).status).toBe(401);
    expect((await getMe(ready.url, credential.token)).status).toBe(200);
    expect((await getModelConnections(ready.url, credential.token)).status).toBe(200);

    // S1-22: the second start made a new `local` default for the deleted one, kept exactly one
    // `local` profile, and attached it to the agent that lost its profile: its run is accepted
    // again with no new push and no pointer move.
    const profiles = await listRuntimeProfiles(ready.url, credential.token);
    const local = profiles.filter((profile) => profile.name === 'local');
    expect(local).toStrictEqual([expect.objectContaining({ driver: 'local' })]);
    const newDefaultId = local[0]?.id ?? '';
    expect(newDefaultId).not.toBe(agents.runtimeProfileId);
    expect(await getAgentProfileId(ready.url, credential.token, agents.currentId)).toBe(
      newDefaultId,
    );
    const ended = await runPastResolution(ready.url, credential.token, agents.currentId);
    for (const refusal of RUNTIME_RESOLUTION_FAILURES) {
      expect(ended.error ?? '', `the run's error names ${refusal}`).not.toContain(refusal);
    }

    // The stop revoked the first key, not this start's sweep of keys a crashed run left behind.
    const keys = await localApiKeys(firstSession.workspaceId);
    expect(keys).toHaveLength(2);
    const revoked = keys.filter((key) => key.revokedAt !== null);
    expect(revoked).toHaveLength(1);
    const [first] = revoked;
    expect(firstSession.stoppedAt).toBeInstanceOf(Date);
    expect(first?.revokedAt?.getTime()).toBeLessThanOrEqual(firstSession.stoppedAt?.getTime() ?? 0);

    // S1-24: the first key is revoked, yet the widget still opens a session of the agent it
    // pushed, which the bootstrap admin owns; the repair at start moved the agent the first key
    // itself owned (data from before the fix) to the bootstrap admin too.
    expect(agents.surfaceId).not.toBe('');
    const opened = await openSurfaceSession(ready.url, 'main');
    const openedBody: unknown = await opened.json();
    expect(opened.status, JSON.stringify(openedBody)).toBe(201);
    expect(SurfaceSessionResponseSchema.parse(openedBody).agentId).toBe(agents.surfaceId);
    expect(await bootstrapAdminPrincipalId(firstSession.workspaceId)).toBe(agents.ownerPrincipalId);
    expect(await getAgentOwner(ready.url, credential.token, agents.surfaceId)).toBe(
      agents.ownerPrincipalId,
    );
    expect(await getAgentOwner(ready.url, credential.token, agents.earlyId)).toBe(
      agents.ownerPrincipalId,
    );

    expect(await runtime.interrupt()).toStrictEqual({ code: 0, signal: null });
  },
  START_TIMEOUT_MS + STOP_TIMEOUT_MS + RUN_TIMEOUT_MS + 30_000,
);

it('never prints a key on stdout or stderr', () => {
  const tokens = project.runtimes.flatMap((runtime) =>
    runtime.messages.flatMap((message) => (message.type === 'credential' ? [message.token] : [])),
  );
  expect(tokens).toHaveLength(2);
  for (const runtime of project.runtimes) {
    expect(runtime.stdout).not.toContain('ak_live_');
    expect(runtime.stderr).not.toContain('ak_live_');
    for (const token of tokens) {
      expect(runtime.stdout.includes(token)).toBe(false);
      expect(runtime.stderr.includes(token)).toBe(false);
    }
  }
});
