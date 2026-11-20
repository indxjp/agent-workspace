import { createHash } from 'node:crypto';

import {
  createInMemoryWorkspaceScopeResolver,
  type WorkspaceScope,
} from '@agent-workspace/core/db';
import { createRunTokenCodec, type RunTokenSubject } from '@agent-workspace/gateway/tokens';

import type { RunStatus } from '@indx-workspace/contracts/runs';

import { createMemoryDirectory } from '../../rbac/memory-directory';
import type { RunTokenDatabase } from '../../gateway/run-token-verifier';
import type { AgentRecord } from '../../agents/contract';
import type { BuilderDoor } from './mcp';
import type { RunCallerDeps } from './run-caller';

const SECRET = 'run-caller-test-signing-secret-at-least-thirty-two-bytes';
export const WORKSPACE = 'ws-1';
export const OTHER_WORKSPACE = 'ws-2';
export const RUN = 'run-1';
export const SESSION = 'session-1';
export const AGENT = 'agent-1';
export const MEMBER = 'principal-member';
export const START = 1_000;

interface Registered {
  readonly workspaceId: string;
  readonly runId: string;
  readonly hash: string;
  readonly expiresAt: number;
  revoked: boolean;
}

type AgentRow = Partial<Pick<AgentRecord, 'builtin' | 'name' | 'createdByAgent'>>;

export interface RunRow {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly agentId: string;
  status: RunStatus;
}

export interface Fixture {
  readonly now: { value: number };
  readonly database: RunTokenDatabase<WorkspaceScope>;
  readonly directory: ReturnType<typeof createMemoryDirectory>;
  readonly registered: Map<string, Registered>;
  readonly runs: Map<string, RunRow>;
  readonly issue: (
    subject?: Partial<RunTokenSubject>,
    registerAs?: { readonly runId?: string },
  ) => Promise<string>;
  readonly tokens: ReturnType<typeof createRunTokenCodec>;
  readonly agentRows: Map<string, AgentRow>;
  readonly deps: RunCallerDeps<WorkspaceScope>;
}

/** The run row that `setup` starts with, and the one tests put in another workspace. */
export const runRowIn = (workspaceId: string): RunRow => ({
  sessionId: SESSION,
  workspaceId,
  agentId: AGENT,
  status: 'running',
});

/** A run token's caller: a member of the workspace. */
export const MEMBER_CALLER = { caller: { sub: MEMBER, principalKind: 'membership' } } as const;

function createDatabase(
  now: { value: number },
  registered: Map<string, Registered>,
  runs: Map<string, RunRow>,
): RunTokenDatabase<WorkspaceScope> {
  return {
    scopes: createInMemoryWorkspaceScopeResolver([
      { id: WORKSPACE, slug: WORKSPACE },
      { id: OTHER_WORKSPACE, slug: OTHER_WORKSPACE },
    ]),
    runTokens: {
      forScope: (scope) => ({
        isActive: (id, runId, tokenHash) => {
          const row = registered.get(id);
          return Promise.resolve(
            row !== undefined &&
              row.workspaceId === scope.workspaceId &&
              row.runId === runId &&
              row.hash === tokenHash &&
              !row.revoked &&
              row.expiresAt > now.value,
          );
        },
      }),
    },
    runs: {
      forScope: (scope) => ({
        get: (runId) => {
          const row = runs.get(runId);
          return Promise.resolve(row?.workspaceId === scope.workspaceId ? row : null);
        },
      }),
    },
  };
}

function createDirectory(): ReturnType<typeof createMemoryDirectory> {
  return createMemoryDirectory({
    users: [
      {
        id: 'user-member',
        principalId: MEMBER,
        email: 'member@example.test',
        name: 'Member',
        workspaceId: WORKSPACE,
        role: 'builder',
      },
    ],
  });
}

function createIssuer(
  tokens: ReturnType<typeof createRunTokenCodec>,
  registered: Map<string, Registered>,
): Fixture['issue'] {
  return async (subject = {}, registerAs = {}) => {
    const token = await tokens.issue({
      runId: RUN,
      sessionId: SESSION,
      workspaceId: WORKSPACE,
      agentId: AGENT,
      modelConnectionId: 'connection-1',
      ...subject,
    });
    const verified = await tokens.verify(token);
    if (!verified.ok) throw new Error('fixture token did not verify');
    registered.set(verified.claims.tokenId, {
      workspaceId: verified.claims.workspaceId,
      runId: registerAs.runId ?? verified.claims.runId,
      hash: createHash('sha256').update(token).digest('hex'),
      expiresAt: verified.claims.expiresAt,
      revoked: false,
    });
    return token;
  };
}

function createAgents(agentRows: Map<string, AgentRow>): RunCallerDeps<WorkspaceScope>['agents'] {
  return {
    forWorkspace: () => ({
      get: (id) => {
        const row = agentRows.get(id);
        return Promise.resolve(
          row === undefined ? null : { name: 'agent', ownerPrincipalId: MEMBER, ...row },
        );
      },
    }),
  };
}

export function setup(): Fixture {
  const now = { value: START };
  const agentRows = new Map<string, AgentRow>([[AGENT, { builtin: 'builder' }]]);
  const tokens = createRunTokenCodec({ secret: SECRET, now: () => now.value });
  const registered = new Map<string, Registered>();
  const runs = new Map<string, RunRow>([[RUN, runRowIn(WORKSPACE)]]);
  const database = createDatabase(now, registered, runs);
  const directory = createDirectory();
  return {
    now,
    database,
    directory,
    registered,
    runs,
    issue: createIssuer(tokens, registered),
    tokens,
    agentRows,
    deps: { tokens, database, directory, agents: createAgents(agentRows), ceiling: null },
  };
}

export const bearer = (token: string): string => `Bearer ${token}`;
export const mcpPost = (): Request =>
  new Request('http://localhost/api/builder/mcp', { method: 'POST' });

/** A JSON-RPC call to the Builder door, carrying the run token. */
export const rpc = (token: string, method: string, params?: unknown): Request =>
  new Request('http://localhost/api/builder/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: bearer(token) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });

export const ALLOWED = { builder: { allow: ['planner'] } } as const;
export const createdByAgent = { agentId: null, version: 1, runId: 'run-0' } as const;
export const allowed = (deps: RunCallerDeps<WorkspaceScope>): RunCallerDeps<WorkspaceScope> => ({
  ...deps,
  ceiling: ALLOWED,
});

/** The door around the real verifier; these tests never get as far as a tool. */
export const doorOf = (verifyCaller: BuilderDoor['verifyCaller']): BuilderDoor => ({
  verifyCaller,
  ports: null,
  readRun: () => Promise.reject(new Error('the run must not be read')),
});

/** The run a token names, as a reads-only refusal carries it. */
export const RUN_IDENTITY = {
  kind: 'run',
  workspaceId: WORKSPACE,
  runId: RUN,
  sessionId: SESSION,
  agentId: AGENT,
} as const;

/** The member's membership id in the fixture directory. */
export async function memberMembershipId(s: Fixture): Promise<string> {
  const [membership] = await s.directory.forWorkspace(WORKSPACE).listMemberships();
  if (membership === undefined) throw new Error('fixture membership missing');
  return membership.id;
}
