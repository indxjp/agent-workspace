/**
 * The verification workspace fill (`PUT /api/demo/verification/{workspaceId}`, internal spec,
 * "Real-model verification gate (R1)"): every demo template the deployment holds, copied into one
 * ordinary workspace a person made, the same way a visitor's demo copy is made
 * (`DemoTemplates.copyIntoVerification`). The real-model harness (`tests/store/live-verify/`) then
 * runs each entry's suggested prompt there with a `builder` key, against exactly what a visitor gets:
 * the stand-ins in place of the entry's outside systems, the sample files and records, the
 * no-internet sandbox profile, the `default` connection holding the deployment's demo key and the
 * demo caps.
 *
 * Which workspace may be filled: one with an Owner and no member that a demo or a template has. A
 * visitor's demo workspace (it has a guest) and a template (its members are template-owner
 * accounts) are refused, so this never writes over either. The copy is made for the first Owner, who
 * then owns the agents, the stand-ins and the files, and is the agents' one grant. A filled
 * workspace is marked (`demo_verification_at`), and keeps approved demo writes (ADR-0169 D3).
 */
import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';

import type { DirectoryRoot } from '../../identity';
import type { DemoVerificationOperations } from '../operator';
import type { DemoRunLimits, DemoTemplates } from './ports';
import { isTemplateOwnerEmail } from './template-owner';

export function createDemoVerification(deps: {
  readonly templates: Pick<DemoTemplates, 'exists' | 'copyIntoVerification'>;
  /** Every entry the deployment holds a template for, in the order they are copied. */
  readonly templateEntries: () => Promise<readonly DemoEntrySlug[]>;
  readonly directory: Pick<DirectoryRoot, 'forWorkspace'>;
  /** The visitor's caps (`AW_DEMO_MAX_TURNS_PER_RUN`, `AW_DEMO_MAX_COST_PER_RUN_USD`). */
  readonly limits: DemoRunLimits;
  /**
   * Mark the workspace as the verification workspace (`workspaces.demo_verification_at`, kept from
   * the first fill), so an approved write to a records stand-in is kept there as in a visitor's
   * demo (ADR-0169 D3).
   */
  readonly markVerificationWorkspace: (workspaceId: string, now: Date) => Promise<void>;
}): DemoVerificationOperations {
  return {
    async fill({ workspaceId, now }) {
      const members = await deps.directory.forWorkspace(workspaceId).listMemberships();
      if (members.length === 0) return { kind: 'workspace-not-found' };
      const isDemoOrTemplate = members.some(
        (member) => member.role === 'guest' || isTemplateOwnerEmail(member.email),
      );
      const owner = members.find((member) => member.role === 'owner');
      if (isDemoOrTemplate || owner === undefined) return { kind: 'workspace-refused' };
      await deps.markVerificationWorkspace(workspaceId, now);
      const entries: DemoEntrySlug[] = [];
      for (const entry of await deps.templateEntries()) {
        if (!(await deps.templates.exists(entry))) continue;
        await deps.templates.copyIntoVerification({
          entry,
          workspaceId,
          ownerUserId: owner.userId,
          limits: deps.limits,
          now,
        });
        entries.push(entry);
      }
      return { kind: 'filled', entries };
    },
  };
}
