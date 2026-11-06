import { createRunTokenCodec } from '@agent-workspace/gateway/tokens';
import type { RunStatus } from '@indx-workspace/contracts/runs';
import { BUILDER_SHIPPED_SUMMARY } from '../../agent/prompt-version';
import type { Role } from '../../../rbac/core/roles';
import { createMemoryDirectory } from '../../../rbac/memory-directory';
import {
  SECRET,
  WORKSPACE,
  SESSION,
  BUILDER_AGENT,
  BUILDER_VERSION_ID,
  MEMBERS,
  type JournalRow,
} from './harness-contract';
import type { InMemoryAgentVersionStoreProvider } from '../../../agent-versions/memory-store';
import type { AuditDeps } from '../../adapters/audit/store';

export function createHarnessState(
  scopes: AuditDeps['scopes'],
  readVersions: () => InMemoryAgentVersionStoreProvider,
) {
  const tokens = createRunTokenCodec({ secret: SECRET });
  const registered = new Map<string, { runId: string; hash: string }>();
  const runs = new Map<string, { model: string; status: RunStatus; agentId: string }>();
  const portCalls: string[] = [];
  const journal: JournalRow[] = [];
  const responses: string[] = [];
  const responseHeaders: string[] = [];
  const database = {
    scopes,
    runTokens: {
      forScope: () => ({
        isActive: (id: string, runId: string, hash: string) =>
          Promise.resolve(registered.get(id)?.runId === runId && registered.get(id)?.hash === hash),
      }),
    },
    runs: {
      forScope: () => ({
        get: (runId: string) => {
          const run = runs.get(runId);
          return Promise.resolve(
            run === undefined
              ? null
              : {
                  sessionId: SESSION,
                  workspaceId: WORKSPACE,
                  agentId: run.agentId,
                  status: run.status,
                  model: run.model,
                  agentVersion: 1,
                },
          );
        },
      }),
    },
    agentVersions: {
      forScope: () => ({
        find: async (agentId: string, number: number) =>
          agentId === BUILDER_AGENT && number === 1
            ? { id: BUILDER_VERSION_ID, number: 1, summary: BUILDER_SHIPPED_SUMMARY }
            : ((await (await readVersions().forWorkspace(WORKSPACE))?.find(agentId, number)) ??
              null),
      }),
    },
    builderToolCalls: {
      forScope: () => ({
        record: (row: JournalRow) => {
          const taken = journal.some(
            (seen) => seen.runId === row.runId && seen.callId === row.callId,
          );
          if (!taken) journal.push(row);
          return Promise.resolve(!taken);
        },
        listForRun: (runId: string) =>
          Promise.resolve(journal.filter((row) => row.runId === runId)),
        findCall: (runId: string, callId: string) =>
          Promise.resolve(
            journal.find((row) => row.runId === runId && row.callId === callId) ?? null,
          ),
        listSpentInputs: (runId: string, tool: string) =>
          Promise.resolve(
            journal
              .filter(
                (row) =>
                  row.runId === runId &&
                  row.tool === tool &&
                  (row.outcome === 'ok' || row.outcome === 'error'),
              )
              .map((row) => row.inputJson),
          ),
      }),
    },
  };
  const directory = createMemoryDirectory({
    users: (Object.entries(MEMBERS) as [Role, string][]).map(([role, principalId]) => ({
      id: `user-${role}`,
      principalId,
      email: `${role}@example.test`,
      name: role,
      workspaceId: WORKSPACE,
      role,
    })),
  });

  return {
    tokens,
    registered,
    runs,
    portCalls,
    journal,
    responses,
    responseHeaders,
    database,
    directory,
  };
}
