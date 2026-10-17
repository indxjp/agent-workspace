import type { Role } from '../../rbac/roles';
import type { WorkspaceSharing } from '../core/runtime';
import { DomainError } from '../../errors';

export function isPublicSharingEnabled(sharing: WorkspaceSharing): Promise<boolean> {
  return sharing.shares.getPublicSharingEnabled();
}
export async function setPublicSharingPolicy(
  enabled: boolean,
  role: Role,
  sharing: WorkspaceSharing,
  actor: { principalId: string; userId: string | null; userLabel: string },
): Promise<void> {
  if (role !== 'owner') {
    throw new DomainError({
      category: 'forbidden',
      code: 'forbidden',
      publicMessage: 'Only an Owner may change the public sharing policy.',
    });
  }
  await sharing.shares.setPublicSharingEnabled(enabled);
  await sharing.audit.write({
    actorPrincipalId: actor.principalId,
    actorUserId: actor.userId,
    actorLabel: actor.userLabel,
    action: 'public-sharing-policy-changed',
    subjectId: null,
    subjectLabel: `Public sharing: ${enabled ? 'on' : 'off'}`,
  });
}
