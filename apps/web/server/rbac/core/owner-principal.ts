/**
 * Issue #509 (S1-24): the principal that owns what a caller writes, read from one of the
 * structural caller projections (`RunPrincipal`, `SessionApiPrincipal`, `ProjectActor`,
 * `ShareActor`) that the composition roots build from the nominal `Principal` in `principal.ts`.
 *
 * Every composition root copies `Principal.ownerPrincipalId` into the projection, and the field is
 * required on every projection so that a root which forgets to copy it is a compile error rather
 * than a silent fallback to the acting principal (which would make a local runtime key own what it
 * writes again, the #509 bug). A caller that owns what it writes (a session, a user token or a
 * hosted key) sets it to its own `principalId`.
 */
interface OwnerProjection {
  /** The principal that acted. */
  readonly principalId: string;
  /** The principal that owns what this caller writes; equal to {@link principalId} unless it is a local runtime key. */
  readonly ownerPrincipalId: string;
}

/** The principal own/other is decided against and that owns what `caller` writes. */
export function ownerPrincipalIdOf(caller: OwnerProjection): string {
  return caller.ownerPrincipalId;
}

/** Who may reach `session` (`canAccessSession`'s rule): its owner, or a workspace owner or admin. */
export function mayAccessSession(
  caller: OwnerProjection & { readonly role?: string },
  session: { readonly ownerPrincipalId?: string | null },
): boolean {
  return (
    session.ownerPrincipalId === ownerPrincipalIdOf(caller) ||
    caller.role === 'owner' ||
    caller.role === 'admin'
  );
}
