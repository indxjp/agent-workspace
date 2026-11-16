/**
 * The maintenance verdicts' operations (internal spec, "The GCP deployment"): the daily production
 * test's verdict on a live entry is kept as the entry's state, and the store reads the entries under
 * maintenance. Over `DemoEntryStates`, the table the platform keeps them in.
 */
import { DemoEntrySlugSchema } from '@indx-workspace/contracts/demo';
import type { DemoEntryStates } from './ports';

import type { DemoMaintenanceOperations } from '../operator';

export function createDemoMaintenanceOperations(
  states: DemoEntryStates,
): DemoMaintenanceOperations {
  return {
    set: ({ entry, request, now }) =>
      states.set({ entry, state: request.state, reason: request.reason, now }),
    async underMaintenance() {
      const slugs = await states.underMaintenance();
      // A slug the contract does not know (a catalog entry since removed) is not shown.
      return slugs.flatMap((slug) => {
        const parsed = DemoEntrySlugSchema.safeParse(slug);
        return parsed.success ? [parsed.data] : [];
      });
    },
  };
}
