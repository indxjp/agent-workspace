/**
 * What the `/workspaces` screen and the sidebar switcher ask of the API, as functions over an SDK
 * client so they are testable with the SDK's `fetchDouble`. The client validates every answer
 * against the contracts. A failure becomes a {@link WorkspacesProblem}, which keeps the status and
 * code that session recovery branches on and the server's own wording.
 */
import type {
  CreateWorkspaceInput,
  UpdateWorkspacePatch,
} from '@indx-workspace/contracts/workspaces';
import {
  ApiProblemError,
  ContractViolationError,
  type AgentWorkspaceClient,
} from '@indx-workspace/sdk';

import type {
  WorkspaceMembership,
  WorkspaceResource,
  WorkspacesProblem,
} from './workspaces-directory';

/** The SDK client the screens hand to the model; only this file imports the SDK. */
export type WorkspacesClient = AgentWorkspaceClient;

export type WorkspacesResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: WorkspacesProblem };

export function describeWorkspacesError(error: unknown): WorkspacesProblem {
  if (error instanceof ApiProblemError) {
    return {
      kind: 'api',
      status: error.status,
      code: error.code,
      detail:
        error.details.length === 0 ? error.message : `${error.message} ${error.details.join(' ')}`,
    };
  }
  if (error instanceof ContractViolationError) {
    return { kind: 'transport', reason: 'The server answered without the usual workspaces body.' };
  }
  return {
    kind: 'transport',
    reason: `The request failed before the server could answer: ${error instanceof Error ? error.message : String(error)}`,
  };
}

async function settle<T>(call: () => Promise<T>): Promise<WorkspacesResult<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    return { ok: false, problem: describeWorkspacesError(error) };
  }
}

export function loadWorkspaces(
  client: WorkspacesClient,
): Promise<WorkspacesResult<readonly WorkspaceMembership[]>> {
  return settle(() => client.workspaces.list());
}

export function createWorkspace(
  client: WorkspacesClient,
  input: CreateWorkspaceInput,
): Promise<WorkspacesResult<WorkspaceMembership>> {
  return settle(() => client.workspaces.create(input));
}

/** `PATCH` answers the workspace row without a role; the caller keeps the role it already holds. */
export function updateWorkspace(
  client: WorkspacesClient,
  workspaceId: string,
  patch: UpdateWorkspacePatch,
): Promise<WorkspacesResult<WorkspaceResource>> {
  return settle(() => client.workspaces.update(workspaceId, patch));
}
