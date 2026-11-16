/**
 * `fakePerson`: a `Person` for an app's tests (issue #1502), without a session or an identity
 * assertion.
 */
import type { MembershipRoleName } from '@indx-workspace/contracts/team';

import type { Person } from '../person.js';

/** The workspace every fake person is in unless told otherwise. */
export const FAKE_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

/** What {@link fakePerson} may be told; everything has a default. */
export interface FakePersonOptions {
  /** `'builder'` when not given; `null` makes a non-member. */
  readonly role?: MembershipRoleName | null;
  /** `'person'` when not given. */
  readonly via?: Person['via'];
  /** For `via: 'agent'`, a fresh UUID when not given. */
  readonly runId?: string;
  /** {@link FAKE_WORKSPACE_ID} when not given. */
  readonly workspaceId?: string;
  /** A fresh UUID when not given. */
  readonly principalId?: string;
}

/** A person for a test: a builder of {@link FAKE_WORKSPACE_ID}, in person, unless told otherwise. */
export function fakePerson(options: FakePersonOptions = {}): Person {
  const via = options.via ?? 'person';
  const runId = options.runId ?? (via === 'agent' ? crypto.randomUUID() : undefined);
  return Object.freeze({
    principalId: options.principalId ?? crypto.randomUUID(),
    workspaceId: options.workspaceId ?? FAKE_WORKSPACE_ID,
    role: options.role === undefined ? 'builder' : options.role,
    via,
    ...(runId === undefined ? {} : { runId }),
  });
}
