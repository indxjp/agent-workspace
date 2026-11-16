import type { StoreLeadRepository } from '@agent-workspace/core/db';

import type { LeadStore } from '../../ports';

export type { StoreLeadRepository };

/** The production {@link LeadStore}: the `store_leads` repository, one statement per call. */
export function createLeadStore(repository: StoreLeadRepository): LeadStore {
  return {
    recordContact: (input) => repository.recordContact(input),
    recordEnquiry: (input) => repository.recordEnquiry(input),
    recordLaunchNotice: (input) => repository.recordLaunchNotice(input),
    deleteLastContactBefore: (cutoff) => repository.deleteLastContactBefore(cutoff),
  };
}
