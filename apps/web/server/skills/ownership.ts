import type { OwnershipResolver } from '../identity';
import { applicationContext } from '../application-context';

/**
 * Issue #117: load the skill's catalog row within the caller's workspace and compare its
 * `created_by` against the caller. A name with no catalog row answers `unknown` rather than
 * `other` — see `apps/web/server/files/ownership.ts`'s `ownershipOfPath` for the same reasoning.
 * A delete keeps the row until it finishes, so the row names the owner of an interrupted delete.
 */
export function ownershipOfName(name: string): OwnershipResolver {
  return async (principal) => {
    const domain = applicationContext()?.skills;
    const runtime = domain?.kind === 'serving' ? domain.runtime : null;
    if (runtime === null || runtime.catalog === undefined) {
      return { kind: 'ownership', ownership: 'unknown' };
    }
    const skills = await (await runtime.catalog.forWorkspace(principal.workspaceId)).listSkills();
    const owner = skills.find((skill) => skill.name === name)?.ownerPrincipalId ?? null;
    if (owner === null) return { kind: 'ownership', ownership: 'unknown' };
    return { kind: 'ownership', ownership: principal.ownerPrincipalId === owner ? 'own' : 'other' };
  };
}
