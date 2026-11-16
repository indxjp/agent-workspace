/**
 * `GuestWorkspaceBinder` over the RBAC directory: the one adapter, whichever directory (PostgreSQL
 * in production, memory in tests) it is given. The transaction lives in the directory's
 * `bindGuestWorkspace`; this adapter only draws the id of a workspace that may be made and names
 * it, so ids come from the `IdGenerator` and the time from the caller's `Clock`.
 */
import { DEMO_WORKSPACE_LIFETIME_SECONDS } from '@indx-workspace/contracts/email-link';

import type { IdGenerator } from '../../../ids';
import type { DirectoryRoot } from '../../../rbac/directory';
import type { GuestWorkspaceBinder } from '../../ports';

/** The slug of a demo workspace: `demo-` and the last 12 hex digits of its id, valid and short. */
export function demoWorkspaceSlug(workspaceId: string): string {
  return `demo-${workspaceId.replaceAll('-', '').slice(-12)}`;
}

export function createGuestWorkspaceBinder(deps: {
  readonly directory: Pick<DirectoryRoot, 'bindGuestWorkspace'>;
  readonly ids: IdGenerator;
}): GuestWorkspaceBinder {
  return {
    async bind({ email, now }) {
      const workspaceId = deps.ids.newId();
      return deps.directory.bindGuestWorkspace({
        email,
        now,
        workspaceId,
        slug: demoWorkspaceSlug(workspaceId),
        lifetimeSeconds: DEMO_WORKSPACE_LIFETIME_SECONDS,
      });
    },
    // The directory alone holds no demo templates; the demo provisioner (P3) wraps this binder.
    hasEntry: () => Promise.resolve(false),
  };
}
