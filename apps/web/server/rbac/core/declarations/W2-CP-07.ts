/**
 * W2-CP-07 · the sub segments of `/api/sessions/:engineSessionId/**` — spec §20, §21, §14.9.
 *
 * These four routes are declared in `tests/route-declarations/W2-CP-07.ts` and they are the reason
 * this partition exists: on the sub-wave 2b-1 union they were the only routes `decide()` could not
 * classify, and it refused all 64 of their cells rather than granting them the parent's width.
 *
 * The reading each entry records is the one `permissions.ts` already applies to
 * `runs: ['events']` — *"§21 says nothing about events as a capability of their own; they are the
 * contents of the run, so reading them is reading the run."* A session's transcript is the session:
 * §20 defines the `SessionStore` as the durable home of the session's state, and §14.9 requires it
 * to hold *"the Agent SDK session state, not only the session id"*. So §21's Builder *"share own
 * … sessions"* and Viewer *"view their own sessions"* are sentences about this content, and the
 * grants that decide these routes are `sessions`'s own — Owner everything, Admin and Builder their
 * own rows, Viewer read of its own.
 *
 * What is deliberately NOT claimed here: that a transcript is a resource of its own. Making it one
 * would mean writing four roles' grants over it, which is a reading of §21 and belongs in
 * `permissions.ts` with the rest of §21's table. Attaching it to its parent is the narrower claim,
 * and it is the one §21's text supports.
 */
import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'W2-CP-07',
    resource: 'sessions',
    sub: 'transcript',
    because:
      '§21 Viewer — "view their own sessions" — and Builder — "share own agents, projects and sessions". A session\'s transcript is what §20 makes the SessionStore durable for and what §14.9 calls "the Agent SDK session state, not only the session id", so reading, appending to or archiving it is reading, writing or archiving the session. Same reading permissions.ts records for runs/events.',
  },
  {
    owner: 'W2-CP-07',
    resource: 'sessions',
    sub: 'subkeys',
    because:
      '§20 lists "Resume session" among the operations the platform must support, and R-01 §7 makes a subagent transcript part of what a resume restores. A subkey names a transcript of this same session, so listing them is reading the session; §21 gives no separate capability over them.',
  },
];
