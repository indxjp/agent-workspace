import type {
  PublishShareCommand,
  ShareExpiry,
  ShareSubjectType,
  ShareVisibility,
} from '@indx-workspace/contracts/shares';
import { ApiProblemError, type AgentWorkspaceClient } from '@indx-workspace/sdk';

import { shareStrings, type ShareStrings } from './share-dialog-messages';

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
 * The link a person can paste anywhere. The server answers a public share's `url` as a path
 * (`/p/<token>`); pasted into an email or chat, a path opens nothing, so it is resolved against the
 * origin the person is using the console on.
 */
export function absoluteShareUrl(url: string, origin: string): string {
  return new URL(url, origin).href;
}

/**
 * What the dialog says after publishing a public link. The server keeps only the token's hash, so
 * this is the only time the link exists anywhere (part 06 step 3 phase 2); the link stays last so
 * a hand copy does not pick up a full stop.
 */
export function oneTimeLinkMessage(
  url: string,
  copied: boolean,
  strings: ShareStrings = shareStrings('en'),
): string {
  return strings.oneTimeLink(url, copied);
}

/** Only "Anyone with the link" makes a link, so only that choice says it copies one. */
export function publishButtonLabel(
  visibility: ShareVisibility,
  strings: ShareStrings = shareStrings('en'),
): string {
  return visibility === 'public' ? strings.copyLink : strings.share;
}

/**
 * Publish a share. The public link when there is one, `null` for a private or workspace share,
 * or the sentence to show when the server refused it.
 */
export async function publishShare(
  client: AgentWorkspaceClient,
  command: PublishShareCommand,
  strings: ShareStrings = shareStrings('en'),
): Promise<{ readonly url: string | null } | { readonly problem: string }> {
  try {
    const share = await client.shares.publish(command);
    return { url: share.url ?? null };
  } catch (reason) {
    return {
      problem: reason instanceof ApiProblemError ? reason.message : strings.notCreated,
    };
  }
}
