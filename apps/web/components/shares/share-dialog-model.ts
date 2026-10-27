import type {
  PublishShareCommand,
  ShareExpiry,
  ShareSubjectType,
  ShareVisibility,
} from '@indx-workspace/contracts/shares';
import { ApiProblemError, type AgentWorkspaceClient } from '@indx-workspace/sdk';

export type ShareSubject = {
  readonly type: ShareSubjectType;
  readonly id: string;
  readonly label: string;
};

/**
 * The publish command the dialog sends. A session share names the runs it showed and the server
 * copies their text (ADR-0158); an agent share publishes its definition.
 */
export function sharePublishCommand(
  subject: ShareSubject,
  visibility: ShareVisibility,
  expiry: ShareExpiry,
  passphrase: string,
  runIds: readonly string[] = [],
): PublishShareCommand {
  return {
    subjectType: subject.type,
    subjectId: subject.id,
    subjectLabel: subject.label,
    visibility,
    ...(subject.type === 'agent' ? { mode: 'definition' as const } : {}),
    expiry,
    ...(passphrase ? { passphrase } : {}),
    ...(subject.type === 'session' && runIds.length > 0 ? { transcript: { runIds } } : {}),
  };
}

/**
 * Publish a share. The public link when there is one, `null` for a private or workspace share,
 * or the sentence to show when the server refused it.
 */
export async function publishShare(
  client: AgentWorkspaceClient,
  command: PublishShareCommand,
): Promise<{ readonly url: string | null } | { readonly problem: string }> {
  try {
    const share = await client.shares.publish(command);
    return { url: share.url ?? null };
  } catch (reason) {
    return {
      problem: reason instanceof ApiProblemError ? reason.message : 'Share could not be created.',
    };
  }
}
