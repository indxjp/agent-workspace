/** The scope error a caller outside the database layer also names; see `./scope.ts`. */
/**
 * Thrown when a caller asks for a repository bound to a workspace that no longer exists.
 *
 * A named error rather than a silent empty result, because the two are different facts and only
 * one of them is survivable: "this workspace has no agents" and "this workspace was deleted while
 * you held a session for it" must not render the same. ADR-0015 — a check that cannot run fails,
 * it does not fall through to the answer that looks like success.
 */
export class UnknownWorkspaceError extends Error {
  public readonly workspaceId: string;

  public constructor(workspaceId: string) {
    super(
      `no workspace has id ${workspaceId}; a repository cannot be scoped to a workspace that ` +
        'does not exist',
    );
    this.name = 'UnknownWorkspaceError';
    this.workspaceId = workspaceId;
  }
}
