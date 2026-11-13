import { createHash, randomUUID } from 'node:crypto';
import { type RunTokenSubject } from '@agent-workspace/gateway/tokens';
import { callContextOf } from '../../testing/context';
import { installTestRunApi, resetTestRunApi } from '../../../application-context-fixtures';
import { decideRunApproval } from '../../../runs/approval';
import {
  WORKSPACE,
  SESSION,
  BUILDER_AGENT,
  MEMBERS,
  type Door,
} from './harness-contract.test-support';
import type { createHarnessState } from './harness-state.test-support';
import type { createHarnessAgents } from './harness-agents.test-support';
import type { createHarnessRunApi } from './harness-run-api.test-support';
import type { BuilderPorts } from '../../tools/types';

export function createHarnessLifecycle(
  context: ReturnType<typeof createHarnessState> &
    ReturnType<typeof createHarnessAgents> &
    ReturnType<typeof createHarnessRunApi> & { readonly ports: BuilderPorts },
): Pick<Door, 'end' | 'revoke' | 'decide' | 'seedAgent' | 'agent' | 'start'> {
  const { runs, tokens, registered, requireRunApi, ports, agents, runStore, person } = context;
  return {
    end(runId) {
      const run = runs.get(runId);
      if (run === undefined) throw new Error('no such run');
      run.status = 'completed';
    },

    revoke(token) {
      return tokens.verify(token).then((verified) => {
        if (!verified.ok) throw new Error('the fixture token does not verify');
        registered.delete(verified.claims.tokenId);
      });
    },

    async decide(runId, decision) {
      installTestRunApi(requireRunApi());
      try {
        const response = await decideRunApproval(
          new Request(`http://web.test/api/runs/${runId}/approval`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-test-user': '1' },
            body: JSON.stringify({ decision }),
          }),
          runId,
        );
        const body = (await response.json()) as { run?: { id: string } };
        if (body.run === undefined) throw new Error(`approval answered ${response.status}`);
        return { status: response.status, runId: body.run.id };
      } finally {
        resetTestRunApi();
      }
    },

    async seedAgent(body, madeBy) {
      const ctx = callContextOf(
        WORKSPACE,
        'admin',
        MEMBERS.admin,
        'user-admin',
        madeBy?.runId ?? 'seed-run',
      );
      const saved = await ports.store.save(ctx, {
        body,
        ...(madeBy === undefined
          ? {}
          : { createdByAgent: { agentId: madeBy.agentId, version: madeBy.version } }),
      });
      if (!saved.ok) throw new Error(`the fixture agent was not saved: ${saved.code}`);
      return saved.agentId;
    },

    agent: (agentId) => agents.forWorkspace(WORKSPACE).get(agentId),

    async start(starter, model, adopt, agentId = BUILDER_AGENT) {
      const runId = adopt ?? randomUUID();
      runs.set(runId, { model, status: 'running', agentId });
      if (runStore !== undefined && adopt === undefined) {
        await runStore.create({
          id: runId,
          engine: 'claude-agent-sdk',
          workspaceId: WORKSPACE,
          agentId,
          sessionId: SESSION,
          initiatingUserId: person.userId,
          ownerPrincipalId: person.principalId,
        });
      }
      await runStore?.markRunning(runId);
      const caller: RunTokenSubject['caller'] =
        'apiKey' in starter
          ? { sub: 'api-key-1', principalKind: 'api-key' }
          : { sub: MEMBERS[starter.role], principalKind: 'membership' };
      const token = await tokens.issue({
        runId,
        sessionId: SESSION,
        workspaceId: WORKSPACE,
        agentId,
        modelConnectionId: 'connection-1',
        caller,
      });
      const verified = await tokens.verify(token);
      if (!verified.ok) throw new Error('the fixture token does not verify');
      registered.set(verified.claims.tokenId, {
        runId,
        hash: createHash('sha256').update(token).digest('hex'),
      });
      return { runId, token };
    },
  };
}
