/**
 * `Principal` — the one thing a handler is ever handed, and the answer to plan §5.2's question of
 * how §22's API keys and §21's sessions share one authorisation layer "without introducing a
 * second framework".
 *
 * R-12 §2.3 states the answer and this file is it: one nominal type produced by two verifiers and
 * consumed by everything. `decide()` takes the role and never asks how it was proved, so there is
 * no second framework because there is no second type.
 *
 * ## Nominality, and why it is the same shape as `CallerWorkspace`
 *
 * `apps/web/server/auth/workspace.ts` already establishes the pattern and the reasoning: the
 * property that matters is *provenance* — a role was read from a membership row or from an API-key
 * row, and from nothing else — and a structural type cannot hold one. A `#private` field is
 * dropped by an object spread and cannot be named, written or satisfied from another module, so
 * `{ ...principal, role: 'owner' }` and `{ workspaceId: body.ws, role: body.role, … }` are both
 * compile errors, and `Object.assign(principal, { role: 'owner' })` throws because the instance is
 * frozen.
 *
 * ## The role does NOT come from the session token
 *
 * A session carries no role: `apps/web/server/auth/session.ts` no longer writes one (refactoring
 * part 06 step 9) and accepts only `'owner'` from an older cookie, which nothing reads. This module
 * keeps that shape deliberately: the role is read from the directory at
 * request time, not carried in the cookie. A role in a bearer token is a role that keeps working
 * for the rest of the token's life after an administrator takes it away; a role read per request
 * takes effect on the next request. That is the same property R-12 §1.5 gives as the reason to
 * keep API keys stateful.
 *
 * ## The session's workspace and the workspace id must be the same workspace
 *
 * `fromSession` used to take `claims` and a `workspaceId` as two independent arguments and never
 * compare them, so a composition root that resolved the wrong workspace — or resolved one for a
 * different tenant's slug — produced a `Principal` scoped to a workspace the session never
 * mentioned. Nothing on this branch calls it outside the harness, which is exactly why it is
 * worth fixing before something does. It now takes the workspace as `{ id, slug }` and asserts,
 * positively, that `slug` is the one the verified session carries; a mismatch is
 * {@link SessionPrincipalResult} `ok: false` and no `Principal` at all, never a downgraded one.
 *
 * ## Who acted, and who owns what was written (issue #509, S1-24)
 *
 * `principalId` is the principal that acted: audit `actorPrincipalId`, an agent version's
 * `createdByPrincipalId`, a browser token's `mintedByPrincipalId` and `GET /api/me` record it.
 * `ownerPrincipalId` is the principal that owns what this caller writes, and the one every own/other
 * decision compares a resource's owner against. The two are the same principal for a session, a
 * user token and a hosted API key. They differ only for the per-run local runtime key `aw dev`
 * mints (ADR-0109, S1-21): that key acts for the bootstrap admin who issued it
 * (`workspace_principals.acts_for_principal_id`), so what it writes is owned by that admin's
 * membership principal and survives the key being swept, revoked or expiring.
 */
import type { VerifiedSignInSessionClaims } from '../auth/session';

import type { ApiKeyIdentity } from './directory';
import type { Role } from './core/roles';
import type { TokenScope } from './core/token-scope';
import { hasConsistentFields } from './principal-invariants';

export { TOKEN_SCOPE_KINDS, type TokenScope, type TokenScopeKind } from './core/token-scope';

/**
 * The tenant, in both the spellings this program uses: `workspaces.id`, which scopes every row
 * (§25), and `workspaces.slug`, which is what a session token carries.
 */
export interface SessionWorkspace {
  readonly id: string;
  readonly slug: string;
}

/** A principal built from a session, or the reason none was. */
export type SessionPrincipalResult =
  | { readonly ok: true; readonly principal: Principal }
  | { readonly ok: false; readonly because: string };

/**
 * How the caller proved who they are. `browser-token` (issue #236, SDK-04, S-1) is not a fourth
 * identity: it is the *minting* principal's session or API-key identity, attenuated by a
 * {@link TokenScope}. `kind` stays the minter's, which is what leaves `workspace_principals`'s
 * CHECK constraint, every `owner_principal_id` foreign key and `wireKind`'s enum untouched.
 * `user-token` (issue #242, SDK-10, S-22) is not one either: it is a person's Membership, proved
 * by the token `aw login` holds instead of by the session cookie.
 */
export type Via = 'session' | 'api-key' | 'browser-token' | 'user-token' | 'oauth-token';

/**
 * What an OAuth access token (ADR-0134 part 3) adds to its subject: the endpoint client it was
 * issued to, and the one URL it is valid for. Present exactly when `via === 'oauth-token'`.
 */
export interface OAuthGrant {
  readonly clientId: string;
  readonly audience: string;
}

/**
 * The durable workspace-local identities that own rows and receive authorization decisions.
 *
 * A tuple rather than a bare union so the list is a value something can quantify over, the way
 * `roles.ts` exports `ROLES` beside `Role`. `apps/web/server/sdk-conformance.*.test.ts` crosses it
 * with `@indx-workspace/contracts`'s own `PRINCIPAL_KINDS` through the mapping `GET /api/me`
 * uses, so neither vocabulary can gain, lose or rename a member alone.
 *
 * `api_key` is spelled with an underscore because that is the value stored in
 * `workspace_principals.kind` under a CHECK constraint
 * (`packages/core/src/db/schema/workspace-principals.ts`); the wire spells it `api-key`, and
 * `handlers.ts`'s `wireKind` is the one place that reconciles the two.
 */
export const PRINCIPAL_KINDS = ['membership', 'api_key'] as const;

/** One of {@link PRINCIPAL_KINDS}. */
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** Identity facts read from the Membership behind a verified session. */
export interface SessionPrincipalIdentity {
  readonly principalId: string;
  readonly userId: string;
  readonly label: string;
}

function isIncompleteIdentity(identity: SessionPrincipalIdentity): boolean {
  return [identity.principalId, identity.userId, identity.label].some((v) => v.trim() === '');
}

/**
 * The one caller type a domain receives (refactoring part 06, step 9): the facts of an
 * authenticated caller, as {@link Principal} carries them. A domain takes `Caller`, or a
 * `Pick<Caller, …>` of the fields it reads, never an actor type of its own, so a caller is
 * described once and every domain names a field the same way (`label`, not `userLabel`).
 *
 * `Principal` implements it, so the two cannot drift: a field added to one and not the other fails
 * to compile. A plain object of this shape is a description of a caller, not proof of one; only a
 * `Principal` is (its constructor is private and its provenance is nominal).
 */
export interface Caller {
  /** `workspace_principals.id` of the principal that acted. Actor attribution records it. */
  readonly principalId: string;
  /** The principal that owns what this caller writes (issue #509). See {@link Principal.ownerPrincipalId}. */
  readonly ownerPrincipalId: string;
  /** Which durable source this principal represents. */
  readonly kind: PrincipalKind;
  /** The tenant, as `workspaces.id`. Spec §25. */
  readonly workspaceId: string;
  /** Stable display attribution. Never used for authorization. */
  readonly label: string;
  /** `users.id`, present exactly for a Membership principal. */
  readonly userId: string | null;
  /** Compatibility identity: session email or machine label. Never use it for own/other checks. */
  readonly actor: string;
  /** One of spec §21's four roles, read from a membership row or from an `api_keys` row. */
  readonly role: Role;
  /** Which verifier produced this caller. */
  readonly via: Via;
  /** `api_keys.id`, present exactly when `via === 'api-key'`. */
  readonly apiKeyId: string | null;
  /** The attenuation a scoped credential carries, or `null`. See {@link Principal.scope}. */
  readonly scope: TokenScope | null;
  /** The client and audience of an OAuth access token; `null` for every other credential. */
  readonly oauth: OAuthGrant | null;
}

/** Everything a `Principal` is built from; `oauth` is absent except for an OAuth token. */
type PrincipalFields = Omit<Caller, 'oauth'> & { readonly oauth?: OAuthGrant | null };

/**
 * An authenticated caller.
 *
 * The public fields are plain, enumerable and frozen, so a handler reads them as it would from any
 * object and `JSON.stringify` produces exactly them, while nothing can write them.
 */
export class Principal implements Caller {
  /** `workspace_principals.id` of the principal that acted. Actor attribution records it. */
  public readonly principalId: string;

  /**
   * The principal that owns what this caller writes, and the one own/other authorization compares
   * a resource's owner against. Equal to {@link principalId} except for an API key that acts for a
   * membership principal (issue #509, S1-24), where it is that membership principal.
   */
  public readonly ownerPrincipalId: string;

  /** Which durable source this principal represents. */
  public readonly kind: PrincipalKind;

  /** The tenant, as `workspaces.id`. Spec §25. */
  public readonly workspaceId: string;

  /** Stable display attribution. Never used for authorization. */
  public readonly label: string;

  /** `users.id`, present exactly for a Membership principal. */
  public readonly userId: string | null;

  /** Compatibility identity: session email or machine label. Never use it for own/other checks. */
  public readonly actor: string;

  /** One of spec §21's four roles, read from a membership row or from an `api_keys` row. */
  public readonly role: Role;

  /** Which verifier produced this value. */
  public readonly via: Via;

  /** `api_keys.id`, present exactly when `via === 'api-key'`. */
  public readonly apiKeyId: string | null;

  /**
   * The attenuation a scoped credential carries: a run or session scope on `via ===
   * 'browser-token'`, an `a2a-agent` or `mcp-project` scope on an endpoint-scoped API key
   * (ADR-0134). `null` for a session or an unscoped API-key principal — the whole width of `role`
   * is theirs.
   */
  public readonly scope: TokenScope | null;

  /** The client and audience of an OAuth access token; `null` for every other credential. */
  public readonly oauth: OAuthGrant | null;

  /**
   * Unnameable outside this file, dropped by an object spread, and not covered by the freeze.
   * It is what makes this type nominal.
   */
  readonly #provenance: Via;

  /** Takes one {@link PrincipalFields} record; `formal/concept-identity.test.ts` hand-builds with it. */
  private constructor(fields: PrincipalFields) {
    this.principalId = fields.principalId;
    this.ownerPrincipalId = fields.ownerPrincipalId;
    this.kind = fields.kind;
    this.workspaceId = fields.workspaceId;
    this.label = fields.label;
    this.userId = fields.userId;
    this.actor = fields.actor;
    this.role = fields.role;
    this.via = fields.via;
    this.apiKeyId = fields.apiKeyId;
    this.scope = fields.scope;
    this.oauth = fields.oauth ?? null;
    this.#provenance = fields.via;
    Object.freeze(this);
  }

  /**
   * The caller proved a session cookie, the directory answered with their role, and the workspace
   * that role was read in is the workspace the session names — or no principal at all.
   *
   * `claims` is what `verifySignInSessionToken` returned — claims assembled by hand do not type-check
   * here — and `role` is what a membership row said. Neither argument can be a request body: the
   * first because of `VerifiedSignInSessionClaims`'s own `#private` field, the second because the only
   * thing that produces a `Role` from an unknown is `parseRole`, and the only thing this function
   * is ever called with is a directory answer. `workspace` carries both halves of the tenant so
   * that the correspondence between them is checkable here rather than assumed by every caller.
   */
  public static fromSession(
    claims: VerifiedSignInSessionClaims,
    workspace: SessionWorkspace,
    role: Role,
    identity: SessionPrincipalIdentity,
  ): SessionPrincipalResult {
    // The positive assertion, and the whole reason this returns a result rather than a value: the
    // workspace whose id is about to be written into the Principal must be the workspace the
    // verified session names. Two arguments that are never compared are two arguments that can
    // disagree (ADR-0015).
    if (workspace.slug !== claims.ws) {
      return {
        ok: false,
        because:
          `the verified session is for workspace ${JSON.stringify(claims.ws)} and the workspace ` +
          `resolved for it is ${JSON.stringify(workspace.slug)} (id ` +
          `${JSON.stringify(workspace.id)}). A principal is not built from two values that name ` +
          `different tenants; spec §25 makes the workspace the isolation boundary.`,
      };
    }
    if (isIncompleteIdentity(identity)) {
      return { ok: false, because: 'the resolved Membership principal is incomplete.' };
    }
    return {
      ok: true,
      principal: new Principal({
        principalId: identity.principalId,
        ownerPrincipalId: identity.principalId,
        kind: 'membership',
        workspaceId: workspace.id,
        label: identity.label,
        actor: claims.sub,
        role,
        via: 'session',
        userId: identity.userId,
        apiKeyId: null,
        scope: null,
      }),
    };
  }

  /**
   * The caller presented an API key and {@link ApiKeyIdentity} came back from the directory. A key
   * that acts for a membership principal writes as that principal's owner; any other key owns what
   * it writes.
   */
  public static fromApiKey(identity: ApiKeyIdentity): Principal {
    return new Principal({
      principalId: identity.principalId,
      ownerPrincipalId: identity.actsForPrincipalId ?? identity.principalId,
      kind: 'api_key',
      workspaceId: identity.workspaceId,
      label: identity.label,
      actor: identity.label,
      role: identity.role,
      via: 'api-key',
      userId: null,
      apiKeyId: identity.apiKeyId,
      scope: identity.scope ?? null,
    });
  }

  /**
   * Re-read a membership or API-key principal from
   * `@agent-workspace/core/db`'s {@link import('@agent-workspace/core/db').DirectoryPrincipalRecord},
   * with no scope of its own. The one caller is the browser-token verifier
   * (`apps/web/server/composition/session-rbac.ts`), which re-resolves a token's minter on every
   * request and passes the result to {@link fromBrowserToken}; `via` follows from `kind`, so this is
   * indistinguishable from {@link fromSession} or {@link fromApiKey}, before attenuation.
   */
  public static fromDirectoryRecord(record: {
    readonly principalId: string;
    readonly kind: PrincipalKind;
    readonly workspaceId: string;
    readonly role: Role;
    readonly label: string;
    readonly userId: string | null;
    readonly apiKeyId: string | null;
    /** `null` for a principal that owns its writes; required so dropping it is a compile error (#509). */
    readonly actsForPrincipalId: string | null;
  }): Principal {
    return new Principal({
      principalId: record.principalId,
      ownerPrincipalId:
        record.kind === 'api_key'
          ? (record.actsForPrincipalId ?? record.principalId)
          : record.principalId,
      kind: record.kind,
      workspaceId: record.workspaceId,
      label: record.label,
      actor: record.label,
      role: record.role,
      via: record.kind === 'membership' ? 'session' : 'api-key',
      userId: record.userId,
      apiKeyId: record.apiKeyId,
      scope: null,
    });
  }

  /**
   * A browser token verified: `minter` is the minting principal, freshly re-resolved from the
   * directory at verification time — never a role snapshotted onto the token row (this file's
   * header, and {@link Via}'s comment on `browser-token`) — and `scope` is what the token's row
   * says it was minted for.
   *
   * `minter` must itself be `via: 'session'` or `via: 'api-key'`: a browser token cannot mint
   * another one, which the scope grammar in `decide()` already guarantees.
   */
  public static fromBrowserToken(minter: Principal, scope: TokenScope): Principal {
    return new Principal({ ...minter, via: 'browser-token', scope, oauth: null });
  }

  /**
   * A person signed in through `aw login` (issue #242, SDK-10, S-22; ADR-0083): the CLI token's
   * row named the user and the workspace, and `identity` and `role` are that user's Membership of
   * that workspace, re-read from the directory on this request exactly as {@link fromSession}
   * re-reads it — never a role stored on the token. The same Membership principal a browser
   * session of the same person produces, so every route that serves a person serves this one, and
   * every route that refuses an API key (`via === 'api-key'`) still refuses one.
   */
  public static fromUserToken(
    workspaceId: string,
    email: string,
    role: Role,
    identity: SessionPrincipalIdentity,
  ): Principal {
    return new Principal({
      principalId: identity.principalId,
      ownerPrincipalId: identity.principalId,
      kind: 'membership',
      workspaceId,
      label: identity.label,
      actor: email,
      role,
      via: 'user-token',
      userId: identity.userId,
      apiKeyId: null,
      scope: null,
    });
  }

  /**
   * An OAuth access token verified (ADR-0134 part 3): `subject` is the consenting member's
   * Membership, freshly re-read from the directory, so a role change or removal takes effect on the
   * next request; `scope` is the endpoint the client is bound to and `grant` the client and URL the
   * token was issued for.
   */
  public static fromOAuthToken(
    subject: Principal,
    scope: TokenScope,
    grant: OAuthGrant,
  ): Principal {
    return new Principal({
      ...subject,
      via: 'oauth-token',
      apiKeyId: null,
      scope,
      oauth: grant,
    });
  }

  /**
   * The runtime half of the same question, for a value that arrived as `unknown`, was rebuilt by a
   * serialiser, or has been through another module's hands.
   *
   * More than the `#` check, for the reason `CallerWorkspace.isCallerWorkspace` gives: it alone
   * answers `true` for an instance whose public fields were overwritten in place. The field rules
   * in `principal-invariants.ts` are defence in depth, since the freeze already prevents that.
   */
  public static isPrincipal(value: unknown): value is Principal {
    if (typeof value !== 'object' || value === null) return false;
    if (!(#provenance in value)) return false;
    if (!Object.isFrozen(value) || value.via !== value.#provenance) return false;
    return hasConsistentFields(value);
  }
}
