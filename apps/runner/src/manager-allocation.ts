import { type IncomingMessage, type ServerResponse } from 'node:http';
import { withCompensation } from '@agent-workspace/core';
import { type RuntimeConfig } from '@agent-workspace/runtime/driver';
import {
  allocationBody,
  body,
  configFor,
  json,
  providerCredentialOf,
  segment,
  waitUntilInvocable,
  type Allocation,
} from './manager-support.js';
import { parseToolSandboxRequest, ToolSandboxUnavailableError } from './tool-sandbox.js';
import type { RunnerManagerOptions } from './manager-options.js';
import type { ManagerContext } from './manager-context.js';
import { sandboxRequest } from './manager-tools.js';

/** The session's allocation: this process's table, else (stateless) the provider's sandbox. */
async function existingAllocation(
  input: {
    readonly options: RunnerManagerOptions;
    readonly allocations: Map<string, Allocation>;
    readonly bySession: Map<string, string>;
  },
  config: RuntimeConfig,
  sessionKey: string,
  credential: string | undefined,
): Promise<Allocation | undefined> {
  if (input.options.driver.find !== undefined) {
    const handle = await input.options.driver.find(config, credential);
    return handle === undefined ? undefined : { handle, sessionKey };
  }
  const existingId = input.bySession.get(sessionKey);
  return existingId === undefined ? undefined : input.allocations.get(existingId);
}

/**
 * Run `work` once every earlier call for the same `key` has settled, so two requests for one session
 * cannot both find no runtime and both create one.
 */
async function serialised<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  locks.set(key, current);
  try {
    return await current;
  } finally {
    if (locks.get(key) === current) locks.delete(key);
  }
}

type AllocationInput = ManagerContext & {
  req: IncomingMessage;
  res: ServerResponse;
  requestUrl: URL;
};

type AllocationRequest = {
  raw: Record<string, unknown>;
  config: RuntimeConfig;
  credential: string | undefined;
  sessionKey: string;
  toolRequest: ReturnType<typeof parseToolSandboxRequest> | undefined;
};

export async function allocateRuntime(input: AllocationInput): Promise<void> {
  const credential = providerCredentialOf(input.req);
  const raw = await body(input.req, input.maxAllocationBodyBytes);
  const config = configFor(raw, input.options.workspacesRoot, input.expectedDriver);
  let toolRequest: ReturnType<typeof parseToolSandboxRequest> | undefined;
  if (raw['toolSandbox'] !== undefined) {
    toolRequest = sandboxRequest(raw['toolSandbox']);
    if (input.options.toolSandboxes === undefined) {
      throw new ToolSandboxUnavailableError(
        input.options.toolSandboxRefusal ??
          'this runner manager has no tool sandbox configured (set AGENT_WORKSPACE_TOOL_HOST_IMAGE)',
      );
    }
  }
  const sessionKey = `${config.runSpec?.runtimeProfileId ?? ''}:${config.sessionId}`;
  // From the lookup to the table write below there are several awaits (liveness, create, a
  // readiness wait of up to 30 s); a client retry in that window would otherwise create a second
  // runtime on the same workspace and orphan the first.
  const request = { raw, config, credential, sessionKey, toolRequest };
  await serialised(input.sessionLocks, sessionKey, () => allocateSessionRuntime(input, request));
}

async function openAllocationTools(
  input: AllocationInput,
  request: AllocationRequest,
): Promise<Record<string, unknown>> {
  const { raw, config, credential, sessionKey, toolRequest } = request;
  return toolRequest === undefined || input.options.toolSandboxes === undefined
    ? {}
    : {
        toolSandbox: {
          origin: await input.options.toolSandboxes.open(
            {
              key: sessionKey,
              workspaceId: segment(raw['workspaceId'], 'workspaceId', 'invalid_workspace_id'),
              sessionId: config.sessionId,
              workspacesRoot: input.options.workspacesRoot,
              publicBase: `${input.requestUrl.protocol}//${input.requestUrl.host}`,
              ...(credential === undefined ? {} : { providerCredential: credential }),
              ...(config.runSpec?.timeoutSeconds === undefined
                ? {}
                : { timeoutSeconds: config.runSpec.timeoutSeconds }),
            },
            toolRequest,
          ),
        },
      };
}

async function allocateSessionRuntime(
  input: AllocationInput,
  request: AllocationRequest,
): Promise<void> {
  const { raw, config, credential, sessionKey } = request;
  const existing = await existingAllocation(input, config, sessionKey, credential);
  if (existing !== undefined && (await input.options.driver.isLive(existing.handle))) {
    json(input.res, 200, {
      ...allocationBody(existing, input.requestUrl),
      ...(await openAllocationTools(input, request)),
    });
    return;
  }
  input.options.driver.assertCreatable?.(config, credential);
  if (existing !== undefined) {
    input.allocations.delete(existing.handle.id);
    input.bySession.delete(sessionKey);
    await input.options.driver.destroy(existing.handle, credential);
  }
  const handle = await input.options.driver.create(config, credential, {
    awWorkspace: segment(raw['workspaceId'], 'workspaceId', 'invalid_workspace_id'),
  });
  const tools = await withCompensation(
    async () => {
      await waitUntilInvocable(
        handle,
        (candidate) => input.options.driver.isLive(candidate),
        input.runtimeRequestUrl,
        input.readinessPath,
        input.authHeaders,
        input.doFetch,
        input.options.verificationTimeoutMs ?? 30_000,
      );
      return openAllocationTools(input, request);
    },
    () => input.options.driver.destroy(handle, credential),
  );
  const allocation = { handle, sessionKey };
  if (input.options.driver.recover === undefined) {
    input.allocations.set(handle.id, allocation);
    input.bySession.set(sessionKey, handle.id);
  }
  json(input.res, 201, { ...allocationBody(allocation, input.requestUrl), ...tools });
}
