import type { DemoCapsRepository } from '@agent-workspace/core/db';

import type { DemoRunAdmissions } from '../../ports';

export type { DemoCapsRepository };

/** The production {@link DemoRunAdmissions}: one transaction per attempt, locked per subject. */
export function createDemoRunAdmissions(repository: DemoCapsRepository): DemoRunAdmissions {
  return {
    countSince: (userId, since) => repository.countAdmissionsSince(userId, since),
    async admit(input) {
      const outcome = await repository.admit(input);
      return { kind: outcome };
    },
  };
}
