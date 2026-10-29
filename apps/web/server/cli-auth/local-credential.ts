/**
 * S1-21 (issue #500), ADR-0109 as amended: the in-process path by which the local runtime launcher
 * (S1-11) gives `aw dev` its one credential, without a browser and without a route.
 *
 * ## Why a workspace API key and not the CLI user token
 *
 * S1-03 (issue #441) issued the bootstrap admin an `awu_live_` user token through the device-flow
 * rows. ADR-0083 §4 admits that token only on the person-facing prefixes in `token-routes.ts`
 * (`/api/me`, `/api/workspaces`, `/api/invitations`, …), so `aw dev` could not reach
 * `/api/model-connections` or `/api/agents/**`. A workspace API key (`ak_live_…`) is already
 * admitted at the edge on every catalogue route with default security and resolved by the
 * directory, so the runtime now mints one instead.
 *
 * ## How it is minted
 *
 * With `rbac/api-key.ts`'s `mintApiKey`, the only source of a key, into the core directory
 * repository `POST /api/api-keys` also writes through (`DatabaseRoot['directory']`), so only the
 * SHA-256 hash of the secret is stored. Before minting, every unrevoked key in the workspace whose
 * name starts with {@link LOCAL_RUNTIME_API_KEY_NAME_PREFIX} — left by a run that crashed — is
 * revoked, so each run holds exactly one live key. The key expires after `CLI_TOKEN_TTL_SECONDS`
 * (12 hours), the lifetime ADR-0109 already allowed the user token.
 *
 * ## Never more than the bootstrap admin
 *
 * The key's role is always `admin`. The issuer reads the role of `userId`'s own membership of
 * `workspaceId` from the directory, never from its caller, and mints only when that stored role is
 * `owner` or `admin`: exactly the callers `conferRole(role, 'admin')` in `rbac/conferral.ts` allows,
 * so the key never exceeds the person it stands for. No membership, or any other role, is
 * `not_issued`. This module does not import `conferral.ts` itself because it is bundled into the
 * local runtime, whose type-check (`packages/embedded`, `nodenext`) refuses the extensionless
 * relative imports of the RBAC module graph behind it; `local-credential.test.ts` asserts, for every
 * role in `rbac/roles.ts`, that {@link mayHoldLocalApiKey} answers exactly what
 * `conferRole(role, 'admin')` answers, so the two cannot drift.
 *
 * ## It cannot outlive the run
 *
 * An admin key may administer credentials and members, and a child key it minted through
 * `POST /api/api-keys` would survive this key's revocation. `local-runtime-key-guard.ts` therefore
 * refuses a key carrying {@link LOCAL_RUNTIME_API_KEY_NAME_PREFIX} on every write to
 * `/api/api-keys`, `/api/users` and `/api/memberships`, and refuses that prefix in a name given to
 * `POST /api/api-keys`, so only this issuer creates such a name and the prefix is a reliable mark.
 *
 * ## What it writes is owned by the person it acts for (S1-24, issue #509)
 *
 * The key is created with `actsForPrincipalId` set to the issuing member's membership principal,
 * so `Principal.ownerPrincipalId` makes that member, not the per-run key, the owner of every agent,
 * session, skill, file, MCP server, project and share `aw dev` writes; audit and version attribution
 * keep the acting key. Before the sweep revokes earlier keys, a repair step
 * (`reassignLocalRuntimeKeyOwnership`) moves anything an earlier local runtime key's principal
 * still owns, from runs before this fix, to the principal that key acts for, or to this member
 * when it records none. It runs in one transaction and is idempotent. Without it, a restart's sweep
 * or the key's expiry left those resources owned by a principal that no longer resolves, and the
 * widget's `POST /p/s/:name/sessions` answered 404. Hosted keys record no acts-for principal and
 * keep owning what they write.
 *
 * ## What does not change
 *
 * No route is added, ADR-0083's token routes are not widened, and neither `proxy.ts`,
 * `session-rbac.ts` nor the role grants change: only code already running inside the server
 * process, with the workspace's database in hand, can call this.
 *
 * The key is returned once and never logged, and neither is its hash. A database failure becomes
 * `LocalCredentialError('not_issued')`; the database error stays on `cause` for server-side logs
 * and never reaches the message.
 */
import { z } from 'zod';

import { CLI_TOKEN_TTL_SECONDS } from '@indx-workspace/contracts/cli-auth';
import type { MembershipRoleName } from '@indx-workspace/contracts/team';
import {
  LOCAL_RUNTIME_API_KEY_NAME_PREFIX,
  type DatabaseDirectoryRoot,
  type DatabaseWorkspaceDirectory,
  type DirectoryMembershipRecord,
} from '@agent-workspace/core/db';

import { systemClock, type Clock } from '../clock.ts';
import { mintApiKey, randomToken } from '../rbac/api-key.ts';

/**
 * The reserved head of every key the local runtime mints, owned by core so the ownership repair
 * selects exactly these keys (issue #509). A run revokes every unrevoked key whose name starts with
 * it before minting its own; `POST /api/api-keys` refuses it in a name
 * (`local-runtime-key-guard.ts`), so no person's key carries it.
 */
export { LOCAL_RUNTIME_API_KEY_NAME_PREFIX };

/** Random bytes in a key name's suffix: 6 bytes are 8 base64url characters. */
const NAME_SUFFIX_BYTES = 6;

/** How many names are tried before giving up when a name is already taken. */
const NAME_ATTEMPTS = 2;

/** The one role a local runtime key holds. */
const LOCAL_RUNTIME_API_KEY_ROLE = 'admin';

/** Spec §21's four roles, as `memberships.role` stores them. */
type MemberRole = MembershipRoleName;

/**
 * Whether a member holding `role` may hold the local runtime's `admin` key: the callers
 * `conferRole(role, 'admin')` allows (see the header; the unit test pins the equivalence).
 */
export function mayHoldLocalApiKey(role: MemberRole): boolean {
  return role === 'owner' || role === 'admin';
}

const IssueLocalApiKeyInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  userId: z.uuid(),
});

/**
 * What {@link LocalApiKeyCredential.revoke} found: `revoked` by this call, `already-revoked` (by a
 * person, or by a later run's sweep), or `missing`, a row that no longer exists.
 */
export type LocalApiKeyRevokeOutcome = 'revoked' | 'already-revoked' | 'missing';

/** A workspace API key issued in process, and the one way to withdraw it. */
export interface LocalApiKeyCredential {
  /** The whole `ak_live_` key. Shown to no one but the caller. */
  readonly token: string;
  readonly expiresAt: Date;
  readonly workspaceId: string;
  /** Revoke the key, answering what the directory found. */
  revoke(): Promise<LocalApiKeyRevokeOutcome>;
}

type LocalCredentialErrorCode = 'invalid_input' | 'not_issued';

const MESSAGES: Readonly<Record<LocalCredentialErrorCode, string>> = {
  invalid_input: 'workspaceId and userId must both be UUIDs, and nothing else may be given.',
  not_issued: 'The local credential was not issued.',
};

export class LocalCredentialError extends Error {
  readonly code: LocalCredentialErrorCode;

  constructor(code: LocalCredentialErrorCode, options?: { readonly cause: unknown }) {
    super(MESSAGES[code], options);
    this.name = 'LocalCredentialError';
    this.code = code;
  }
}

interface IssueLocalApiKeyDeps {
  /** The database directory (`DatabaseRoot['directory']`). */
  readonly directory: DatabaseDirectoryRoot;
  /** Defaults to {@link systemClock}. */
  readonly clock?: Clock;
}

/** Revoke every unrevoked key a previous local run left behind. */
async function sweepStaleKeys(directory: DatabaseWorkspaceDirectory, now: Date): Promise<void> {
  const keys = await directory.listApiKeys();
  for (const key of keys) {
    if (key.revokedAt === null && key.name.startsWith(LOCAL_RUNTIME_API_KEY_NAME_PREFIX)) {
      await directory.revokeApiKey(key.id, now);
    }
  }
}

/**
 * `userId`'s stored membership of this workspace when it may hold the local runtime's key, or
 * `null`. Its `principalId` is the principal the key acts for.
 */
async function memberMayHoldKey(
  directory: DatabaseWorkspaceDirectory,
  userId: string,
): Promise<DirectoryMembershipRecord | null> {
  const memberships = await directory.listMemberships();
  const membership = memberships.find((row) => row.userId === userId);
  return membership !== undefined && mayHoldLocalApiKey(membership.role) ? membership : null;
}

/**
 * Mint a workspace API key for the local runtime in `workspaceId`, for the member `userId`, and
 * return it with the way to revoke it. The member's role is read from the directory.
 *
 * `input` is `unknown` on purpose, as `conferRole`'s arguments are: it is parsed here, as
 * `{ workspaceId: uuid, userId: uuid }` and nothing else, before anything reads it.
 */
export async function issueLocalApiKey(
  input: unknown,
  deps: IssueLocalApiKeyDeps,
): Promise<LocalApiKeyCredential> {
  const parsed = IssueLocalApiKeyInputSchema.safeParse(input);
  if (!parsed.success) throw new LocalCredentialError('invalid_input');
  const { workspaceId, userId } = parsed.data;

  const clock = deps.clock ?? systemClock;
  const directory = deps.directory.forWorkspace(workspaceId);
  const expiresAt = new Date(clock.now().getTime() + CLI_TOKEN_TTL_SECONDS * 1000);

  let minted: { readonly id: string; readonly presented: string } | undefined;
  let issuer: DirectoryMembershipRecord | null;
  try {
    issuer = await memberMayHoldKey(directory, userId);
  } catch (error) {
    throw new LocalCredentialError('not_issued', { cause: error });
  }
  if (issuer === null) throw new LocalCredentialError('not_issued');
  const toPrincipalId = issuer.principalId;
  try {
    // The repair runs before the sweep (S1-24): it reassigns what earlier local runtime keys own,
    // revoked or not, so nothing is stranded by the revocations that follow.
    await directory.reassignLocalRuntimeKeyOwnership({ toPrincipalId });
    await sweepStaleKeys(directory, clock.now());
    for (let attempt = 0; attempt < NAME_ATTEMPTS && minted === undefined; attempt += 1) {
      const key = await mintApiKey();
      const outcome = await directory.createApiKey({
        name: `${LOCAL_RUNTIME_API_KEY_NAME_PREFIX}${randomToken(NAME_SUFFIX_BYTES)}`,
        role: LOCAL_RUNTIME_API_KEY_ROLE,
        keyPrefix: key.keyPrefix,
        keyHash: key.keyHash,
        expiresAt,
        actsForPrincipalId: toPrincipalId,
      });
      if (outcome.kind === 'created') minted = { id: outcome.key.id, presented: key.presented };
    }
  } catch (error) {
    throw new LocalCredentialError('not_issued', { cause: error });
  }
  if (minted === undefined) throw new LocalCredentialError('not_issued');

  const keyId = minted.id;
  return {
    token: minted.presented,
    expiresAt,
    workspaceId,
    revoke: async () => {
      const outcome = await directory.revokeApiKey(keyId, clock.now());
      switch (outcome.kind) {
        case 'revoked':
          return 'revoked';
        case 'already-revoked':
          return 'already-revoked';
        case 'no-such-key':
          return 'missing';
        default: {
          const unreachable: never = outcome;
          throw new Error(`unhandled revokeApiKey outcome ${JSON.stringify(unreachable)}`);
        }
      }
    },
  };
}
