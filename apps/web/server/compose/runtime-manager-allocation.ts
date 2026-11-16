import type { RuntimeHandle } from '@agent-workspace/runtime/driver';
import type { ManagerTransport, RuntimeManagerClient } from './runtime-manager-client';
import {
  credentialHeader,
  send,
  managerFailure,
  jsonAnswer,
  invalidAnswer,
} from './runtime-manager-errors';
export function createAllocation({
  base,
  headers,
  doFetch,
}: ManagerTransport): RuntimeManagerClient['allocate'] {
  return async (context, spec, toolSandbox, providerCredential) => {
    const request = doFetch(`${base}/runtimes`, {
      method: 'POST',
      headers: {
        ...headers(),
        'Content-Type': 'application/json',
        ...credentialHeader(providerCredential),
      },
      body: JSON.stringify({
        workspaceId: context.principal.workspaceId,
        sessionId: context.session.id,
        // ENG-07 (#306): which engine this run is for, so the manager's driver starts it in that
        // engine's image. `run.engine` and not `agent.engine`: the run row records the engine the
        // session is pinned to, and that is the one the sandbox must actually carry.
        engine: context.run.engine ?? context.agent.engine,
        runSpec: spec,
        ...(toolSandbox === undefined ? {} : { toolSandbox }),
      }),
    });
    const response = await send('allocation', providerCredential, request);
    if (!response.ok) throw await managerFailure('allocation', response, providerCredential);
    const value = await jsonAnswer('allocation', response);
    return parseAllocation(value, response.status, toolSandbox !== undefined);
  };
}

function parseAllocation(
  value: unknown,
  status: number,
  requiresToolSandbox: boolean,
): Awaited<ReturnType<RuntimeManagerClient['allocate']>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidAnswer('allocation', status, 'returned an invalid allocation');
  }
  const record = value as Record<string, unknown>;
  if (typeof record['runnerUrl'] !== 'string' || record['runnerUrl'].length === 0) {
    throw new Error('runtime manager allocation omitted runnerUrl');
  }
  const handle = record['handle'];
  if (handle === null || typeof handle !== 'object' || Array.isArray(handle)) {
    throw new Error('runtime manager allocation omitted its handle');
  }
  const sandbox = record['toolSandbox'];
  const origin =
    sandbox !== null && typeof sandbox === 'object'
      ? (sandbox as Record<string, unknown>)['origin']
      : undefined;
  if (requiresToolSandbox && (typeof origin !== 'string' || origin.length === 0)) {
    throw new Error('runtime manager allocation omitted the tool sandbox origin');
  }
  return {
    handle: handle as RuntimeHandle,
    runnerUrl: record['runnerUrl'],
    ...(!requiresToolSandbox ? {} : { toolSandboxOrigin: origin as string }),
  };
}
