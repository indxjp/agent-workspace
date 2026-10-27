import type { OwnershipResolver } from '../rbac/http';
import { readLegacyPendingSkillDelete } from './pending-delete';
import { applicationContext } from '../application-context';

/**
 * Issue #117: load the skill's catalog row within the caller's workspace and compare its
 * `created_by` against the caller. A name with no catalog row answers `unknown` rather than
 * `other` — see `apps/web/server/files/ownership.ts`'s `ownershipOfPath` for the same reasoning.
 *
 * #240 review: a delete interrupted after its row went (an earlier release removed the row first)
 * has no row left, but its legacy pending-delete marker records the owner (ADR-0077 D3). That owner
 * answers here, so the owning Builder can finish their own delete and nobody else gains the skill.
 * A delete that keeps its row needs no marker: the row names the owner.
 */
export function ownershipOfName(name: string): OwnershipResolver {
  return async (principal) => {
    const domain = applicationContext()?.skills;
    const runtime = domain?.kind === 'serving' ? domain.runtime : null;
    if (runtime === null || runtime.catalog === undefined) {
      return { kind: 'ownership', ownership: 'unknown' };
    }
    const skills = await (await runtime.catalog.forWorkspace(principal.workspaceId)).listSkills();
    const row = skills.find((skill) => skill.name === name);
    const owner =
      row?.ownerPrincipalId ??
      // storage-bridge(#1699): the owner recorded by a legacy marker object
      (await readLegacyPendingSkillDelete(runtime.store.forWorkspace(principal.workspaceId), name))
        ?.ownerPrincipalId ??
      null;
    if (owner === null) return { kind: 'ownership', ownership: 'unknown' };
    return { kind: 'ownership', ownership: principal.ownerPrincipalId === owner ? 'own' : 'other' };
  };
}
