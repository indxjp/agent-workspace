/**
 * The demo provisioner: the production `GuestWorkspaceBinder` of the email-link sign-in (internal
 * spec, "How Try it works"). It wraps the directory binder, which makes (or returns) the visitor's
 * demo workspace and marks a new one with its end, and then does the three things the store needs:
 *
 * 1. adds the chosen entry's demo to the workspace, `new` or returned to, so a visitor who tries
 *    a second entry within the day gets it beside the first;
 * 2. records the contact in the lead store, once per entry;
 * 3. answers `hasEntry` from the templates, so the sign-in refuses an entry with no demo before it
 *    sends or consumes a link.
 *
 * An address that holds a real membership is bound to nothing (`null`), copied to nothing and
 * recorded nowhere: no link session was made for it.
 */
import type { LeadStore } from '../ports';
import type { DemoGuestBinder, DemoRunLimits, DemoTemplates } from './ports';

export function createDemoProvisioner(deps: {
  /** The directory binder (`createGuestWorkspaceBinder`): the workspace, the guest, the end time. */
  readonly directoryBinder: Pick<DemoGuestBinder, 'bind'>;
  readonly templates: DemoTemplates;
  readonly leads: LeadStore;
  /** From `AW_DEMO_MAX_TURNS_PER_RUN` and `AW_DEMO_MAX_COST_PER_RUN_USD`; `null` while unset. */
  readonly limits: DemoRunLimits;
}): DemoGuestBinder {
  return {
    async bind({ email, now, entry }) {
      const binding = await deps.directoryBinder.bind({ email, now });
      if (binding === null) return null;
      if (entry !== undefined) {
        await deps.templates.copyInto({
          entry,
          workspaceId: binding.workspaceId,
          guestUserId: binding.userId,
          limits: deps.limits,
          now,
        });
      }
      await deps.leads.recordContact({
        email: email.trim().toLowerCase(),
        entry: entry ?? null,
        now,
      });
      return binding;
    },
    hasEntry: (entry) => deps.templates.exists(entry),
  };
}
