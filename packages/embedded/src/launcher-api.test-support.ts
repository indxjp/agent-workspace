import { CreateAgentFromVersionResponseSchema } from '@indx-workspace/contracts/agent-versions';
import { DATABASE_PORT } from './launcher-ports.test-support.js';

import { openDatabaseRoot } from '@agent-workspace/core/db';
import { type CreateAgentFromVersionRequestInput } from '@indx-workspace/contracts/agent-versions';
import { AgentResourceSchema } from '@indx-workspace/contracts/agents';
import { type LocalRuntimeStartMessage } from '@indx-workspace/contracts/local-runtime';
import {
  isTerminalRunStatus,
  RunDetailResponseSchema,
  StartRunResponseSchema,
  type RunResource,
} from '@indx-workspace/contracts/runs';
import { RuntimeProfileListResponseSchema } from '@indx-workspace/contracts/runtimes';
import { expect } from 'vitest';
import { z } from 'zod';
import { type Ports } from './launcher-ports.test-support.js';

/** The port every launcher uses when `AW_DATABASE_PORT` is unset; this file never uses it. */
export const DEFAULT_DATABASE_PORT = 25432;
/** How long a runtime whose database port is taken may take to answer `failed` and exit. */
export const PORT_TAKEN_TIMEOUT_MS = 60_000;
const BOOTSTRAP_ADMIN = 'admin@localhost.test';
/** `LOCAL_RUNTIME_API_KEY_NAME_PREFIX` in `apps/web/server/cli-auth/local-credential.ts`. */
const LOCAL_KEY_NAME_PREFIX = 'aw dev local runtime ';
/** The fixed loopback-only role `embedded-db.ts` creates for the embedded database. */
export const EMBEDDED_DATABASE_URL = `postgresql://agent_workspace:agent_workspace_local@127.0.0.1:${String(DATABASE_PORT)}/postgres`;

export const LocalSecretsFileSchema = z.looseObject({
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12),
});

export function getMe(url: string, token: string): Promise<Response> {
  return fetch(new URL('/api/me', url), { headers: { authorization: `Bearer ${token}` } });
}

export function getModelConnections(url: string, token: string): Promise<Response> {
  return fetch(new URL('/api/model-connections', url), {
    headers: { authorization: `Bearer ${token}` },
  });
}

/** How long a started run may take to settle: terminal, or running past its launch. */
export const RUN_TIMEOUT_MS = 120_000;

/**
 * How long a run must stay `running` to count as launched. A run refused while it is prepared
 * (runtime resolution included) is marked `running` and concluded `failed` in the same step, so a
 * run still `running` this long after was handed to the runner. The model call that follows retries
 * against a port nothing serves, so the run is then interrupted rather than waited for.
 */
const LAUNCHED_AFTER_RUNNING_MS = 5_000;

/**
 * A base URL on loopback that nothing listens on (port 9, discard): model discovery cannot read the
 * model list, so the explicit model passes unvalidated (`resolveModelForRun`), and the run fails at
 * the model call — after runtime resolution, which is what this test is about.
 */
export const UNREACHABLE_MODEL_BASE_URL = 'http://127.0.0.1:9';

/** Messages a run must never fail with once the workspace has a default runtime profile. */
export const RUNTIME_RESOLUTION_FAILURES = [
  'agent_runtime_profile_missing',
  'selects unavailable driver',
  'Test Runtime has not passed',
  'selects unsupported driver',
  'no launch target is configured',
  'cannot run on driver',
  // The safe public text of any failure while the run is prepared, runtime resolution included.
  'The run request could not be prepared',
] as const;

export function authorised(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  };
}

export async function listRuntimeProfiles(url: string, token: string) {
  const response = await fetch(new URL('/api/runtime-profiles', url), authorised(token));
  expect(response.status).toBe(200);
  return RuntimeProfileListResponseSchema.parse(await response.json()).runtimeProfiles;
}

export async function getAgentProfileId(url: string, token: string, agentId: string) {
  const response = await fetch(new URL(`/api/agents/${agentId}`, url), authorised(token));
  expect(response.status).toBe(200);
  return AgentResourceSchema.parse(await response.json()).runtimeProfileId;
}

export function startRun(url: string, token: string, agentId: string): Promise<Response> {
  return fetch(
    new URL(`/api/agents/${agentId}/runs`, url),
    authorised(token, { method: 'POST', body: JSON.stringify({ prompt: 'Say hello.' }) }),
  );
}

/**
 * Start a run of `agentId`, expect `202`, and answer it once it is terminal or launched; a launched
 * run is interrupted, since its model call cannot succeed.
 */
export async function runPastResolution(url: string, token: string, agentId: string) {
  const started = await startRun(url, token, agentId);
  const startBody: unknown = await started.json();
  expect(started.status, JSON.stringify(startBody)).toBe(202);
  const { run } = StartRunResponseSchema.parse(startBody);
  const ended = await settledRun(url, token, run.id);
  if (ended.status === 'running') {
    const interrupted = await fetch(
      new URL(`/api/runs/${run.id}/interrupt`, url),
      authorised(token, { method: 'POST' }),
    );
    expect(interrupted.status).toBe(200);
  }
  return ended;
}

/** The model fields of a version's agent: an explicit model, or a connection and no model. */
interface AgentModelFields {
  readonly model: string | null;
  readonly modelConnectionName: string | null;
}

/** The Anthropic id in the launcher's `LOCAL_DEPLOYMENT_DEFAULT_MODELS_JSON` (S1-23). */
export const LOCAL_ANTHROPIC_DEFAULT_MODEL = 'claude-sonnet-4-5';

/**
 * An agent as `aw push` writes it: no runtime profile named, and by default an explicit model and no
 * connection. `model: null` with `modelConnectionName: 'default'` is what `@indx-workspace/sdk`'s
 * version body writes for `model: 'default'` (S1-23).
 */
export function agentFromVersion(
  name = 'Local runner',
  modelFields: AgentModelFields = { model: 'claude-sonnet-4-5', modelConnectionName: null },
  surfaceNames: readonly string[] = [],
): CreateAgentFromVersionRequestInput {
  return {
    version: {
      summary: 'First version',
      via: 'api',
      body: {
        definition: {
          apiVersion: 'agentworkspace.dev/v1',
          kind: 'AgentDefinition',
          agent: {
            name,
            instructions: 'Answer in one sentence.',
            permissions: {
              readFiles: true,
              writeFiles: false,
              runCommands: false,
              unrestrictedNetwork: false,
            },
            model: modelFields.model,
            modelConnectionName: modelFields.modelConnectionName,
            runtimeProfileName: null,
          },
          policy: {
            engine: 'claude-agent-sdk',
            tools: {
              base: 'claude_code_preset',
              autoApprove: [],
              deny: [],
              permissionMode: 'default',
              allowDangerouslySkipPermissions: false,
            },
            skills: { mode: 'all' },
            limits: { maxTurns: null, maxBudgetUsd: null },
          },
          policySource: 'stored',
          resources: { files: [], skills: [], connectors: [] },
        },
        surfaces: surfaceNames.map((surface) => ({ name: surface, agent: name })),
      },
    },
  };
}

/**
 * Poll `GET /api/runs/:id` until the run is terminal or has been `running` for
 * {@link LAUNCHED_AFTER_RUNNING_MS}, or fail after {@link RUN_TIMEOUT_MS}.
 */
async function settledRun(url: string, token: string, runId: string): Promise<RunResource> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let runningSince: number | null = null;
  for (;;) {
    const response = await fetch(new URL(`/api/runs/${runId}`, url), authorised(token));
    expect(response.status).toBe(200);
    const { run } = RunDetailResponseSchema.parse(await response.json());
    if (isTerminalRunStatus(run.status)) return run;
    if (run.status === 'running') {
      runningSince ??= Date.now();
      if (Date.now() - runningSince >= LAUNCHED_AFTER_RUNNING_MS) return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} was still ${run.status} after ${String(RUN_TIMEOUT_MS)} ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The widget's session bootstrap, from a page of the runtime's own origin (S1-24). */
export function openSurfaceSession(url: string, surface: string): Promise<Response> {
  return fetch(new URL(`/p/s/${surface}/sessions`, url), {
    method: 'POST',
    headers: { origin: url },
  });
}

/** The bootstrap admin's membership principal, read from the embedded database. */
export async function bootstrapAdminPrincipalId(workspaceId: string): Promise<string> {
  const database = await openDatabaseRoot({ DATABASE_URL: EMBEDDED_DATABASE_URL });
  try {
    const members = await database.directory.forWorkspace(workspaceId).listMemberships();
    const admin = members.find((member) => member.email === BOOTSTRAP_ADMIN);
    if (admin === undefined) throw new Error('the bootstrap admin has no membership');
    return admin.principalId;
  } finally {
    await database.close();
  }
}

export async function getAgentOwner(url: string, token: string, agentId: string): Promise<string> {
  const response = await fetch(new URL(`/api/agents/${agentId}`, url), authorised(token));
  expect(response.status).toBe(200);
  return AgentResourceSchema.parse(await response.json()).ownerPrincipalId;
}

export function startMessage(projectDir: string, ports: Ports): LocalRuntimeStartMessage {
  return {
    type: 'start',
    projectDir,
    environment: { port: ports.web, runtimeDriver: 'local', bootstrapAdmin: BOOTSTRAP_ADMIN },
  };
}

export async function localApiKeys(workspaceId: string) {
  const database = await openDatabaseRoot({ DATABASE_URL: EMBEDDED_DATABASE_URL });
  try {
    const keys = await database.directory.forWorkspace(workspaceId).listApiKeys();
    return keys.filter((key) => key.name.startsWith(LOCAL_KEY_NAME_PREFIX));
  } finally {
    await database.close();
  }
}

export async function createLocalAgent(
  session: { readonly url: string; readonly token: string },
  input: CreateAgentFromVersionRequestInput,
) {
  const response = await fetch(
    new URL('/api/agents', session.url),
    authorised(session.token, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  );
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(201);
  return CreateAgentFromVersionResponseSchema.parse(body);
}
