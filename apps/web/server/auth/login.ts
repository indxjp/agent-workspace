import type { DirectoryRoot } from '../rbac/directory';

export type OidcSignIn =
  | { readonly kind: 'invitation' }
  | {
      readonly kind: 'session';
      readonly userId: string;
      readonly email: string;
      readonly workspaceSlug: string;
    }
  | { readonly kind: 'select'; readonly userId: string; readonly email: string };

export async function resolveOidcSignIn(
  directory: Pick<
    DirectoryRoot,
    'findIdentity' | 'findUserByEmail' | 'membershipsForUser' | 'linkIdentity'
  >,
  issuer: string,
  identity: { readonly subject: string; readonly email: string },
): Promise<OidcSignIn> {
  // Resolve the identity to a user: an already-bound (issuer, subject) wins; otherwise an existing
  // account with the same email is a candidate. Do not bind that candidate yet. If it has no
  // membership, callback execution alone must create no durable application state; the invitation
  // acceptance transaction performs the binding together with its other writes.
  // The session is minted for the resolved user's DIRECTORY email, never the IdP's claim: a bound
  // subject whose provider email has since changed must stay the user it was bound to.
  const bound = await directory.findIdentity(issuer, identity.subject);
  const candidate = bound === null ? await directory.findUserByEmail(identity.email) : null;
  const user =
    bound ?? (candidate === null ? null : { userId: candidate.id, email: candidate.email });

  const memberships = user === null ? [] : await directory.membershipsForUser(user.userId);

  if (user === null || memberships.length === 0) return { kind: 'invitation' };

  if (candidate !== null) {
    await directory.linkIdentity(issuer, identity.subject, user.userId);
  }

  if (memberships.length === 1) {
    const only = memberships[0];
    if (only === undefined) throw new Error('unreachable: length 1 with no element 0');
    return {
      kind: 'session',
      userId: user.userId,
      email: user.email,
      workspaceSlug: only.workspaceSlug,
    };
  }

  return { kind: 'select', userId: user.userId, email: user.email };
}
