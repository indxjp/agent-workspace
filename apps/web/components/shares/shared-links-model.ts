import type { ShareListItem } from '@indx-workspace/contracts/shares';
import { ApiProblemError, type AgentWorkspaceClient } from '@indx-workspace/sdk';

export type SharingView = {
  readonly shares: readonly ShareListItem[];
  readonly publicSharing: boolean;
};

function problemText(reason: unknown, request: string): string {
  if (reason instanceof ApiProblemError) return `${request} returned ${String(reason.status)}`;
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * The shared-links screen's two reads. A refused read names both statuses (`200` for the one that
 * answered); anything else — a transport failure, a contract violation — rejects with its own error.
 */
export async function loadSharing(client: AgentWorkspaceClient): Promise<SharingView> {
  const [shares, policy] = await Promise.allSettled([
    client.shares.list(),
    client.workspaces.sharingPolicy.get(),
  ]);
  if (shares.status === 'fulfilled' && policy.status === 'fulfilled')
    return { shares: shares.value, publicSharing: policy.value.publicSharing };
  const failures = [shares, policy].flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : [],
  );
  const unexpected = failures.find((reason) => !(reason instanceof ApiProblemError));
  if (unexpected !== undefined)
    throw unexpected instanceof Error ? unexpected : new Error('Sharing request failed.');
  const status = (result: PromiseSettledResult<unknown>): number =>
    result.status === 'fulfilled' ? 200 : (result.reason as ApiProblemError).status;
  throw new Error(`Sharing request returned ${String(status(shares))}/${String(status(policy))}`);
}

/** Revoke a share; the problem to show, or `null` once it is revoked. */
export async function revokeShare(
  client: AgentWorkspaceClient,
  id: string,
): Promise<string | null> {
  try {
    await client.shares.revoke(id);
    return null;
  } catch (reason) {
    return problemText(reason, 'Revoke');
  }
}

/** Turn public sharing on or off; the problem to show, or `null` once the policy is set. */
export async function setPublicSharing(
  client: AgentWorkspaceClient,
  publicSharing: boolean,
): Promise<string | null> {
  try {
    await client.workspaces.sharingPolicy.set({ publicSharing });
    return null;
  } catch (reason) {
    return problemText(reason, 'Policy update');
  }
}
