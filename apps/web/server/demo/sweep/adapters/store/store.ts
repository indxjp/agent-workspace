import type { DemoSweepRepository } from '@agent-workspace/core/db';

import type { DemoSweepStore } from '../../ports';

export type { DemoSweepRepository };

/** The production {@link DemoSweepStore}: the repository's statements, one transaction per workspace. */
export function createDemoSweepStore(repository: DemoSweepRepository): DemoSweepStore {
  return {
    expiredWorkspaceIds: (now, limit) => repository.expiredWorkspaceIds(now, limit),
    deleteExpiredWorkspace: (workspaceId, now) =>
      repository.deleteExpiredWorkspace(workspaceId, now),
    deleteLoginTokensBefore: (cutoff) => repository.deleteLoginTokensBefore(cutoff),
    deleteAdmissionsBefore: (cutoff) => repository.deleteAdmissionsBefore(cutoff),
    deleteIdleGuestUsersBefore: (cutoff) => repository.deleteIdleGuestUsersBefore(cutoff),
  };
}
