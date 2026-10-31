import type {
  DatabaseDirectoryRoot,
  DirectoryApiKeyRecord,
  DirectoryEndpointScope,
  DirectoryInvitationRecord,
  DirectoryMembershipRecord,
  DirectoryUserRecord,
} from '@agent-workspace/core/db';

import { hashApiKeySecret, mintApiKey, parsePresentedKey } from './api-key';
import type {
  ApiKeySummary,
  DirectoryRoot,
  InvitationSummary,
  MembershipSummary,
  StoredApiKey,
  UserSummary,
  WorkspaceDirectory,
} from './directory';
import type { TokenScope } from './token-scope';
import { hashInvitationToken, INVITATION_TTL_MS, mintInvitationToken } from '../invitations/token';

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

function user(row: DirectoryUserRecord): UserSummary {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

// An explicit projection rather than a spread: the public membership shape is these six fields and
// nothing the repository record happens to grow next.
function membership(row: DirectoryMembershipRecord): MembershipSummary {
  return {
    id: row.id,
    principalId: row.principalId,
    userId: row.userId,
    email: row.email,
    name: row.name,
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

function invitation(row: DirectoryInvitationRecord): InvitationSummary {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedBy,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: iso(row.acceptedAt),
    revokedAt: iso(row.revokedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function apiKey(row: DirectoryApiKeyRecord): ApiKeySummary {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    keyPrefix: row.keyPrefix,
    lastUsedAt: iso(row.lastUsedAt),
    expiresAt: iso(row.expiresAt),
    revokedAt: iso(row.revokedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

function storedApiKey(row: DirectoryApiKeyRecord): StoredApiKey {
  return {
    ...apiKey(row),
    workspaceId: row.workspaceId,
    keyHash: row.keyHash,
    keyId: row.keyPrefix.replace(/^ak_live_/u, ''),
  };
}

/** Adapt the scope-safe PostgreSQL repository to the RBAC route contract. */
/** The token scope an endpoint-bound API key carries; a binding of an unknown kind fails closed. */
function tokenScopeOf(scope: DirectoryEndpointScope | null): TokenScope | null {
  if (scope === null) return null;
  switch (scope.kind) {
    case 'a2a-agent':
      return { kind: 'a2a-agent', id: scope.agentId };
    case 'mcp-project':
      return { kind: 'mcp-project', id: scope.clientId };
    default: {
      const unreachable: never = scope;
      throw new Error(`unhandled endpoint scope ${JSON.stringify(unreachable)}`);
    }
  }
}

export function createPostgresDirectory(
  repository: DatabaseDirectoryRoot,
  now: () => Date = () => new Date(),
): DirectoryRoot {
  const forWorkspace = (workspaceId: string): WorkspaceDirectory => {
    const directory = repository.forWorkspace(workspaceId);
    return {
      async listUsers() {
        return (await directory.listUsers()).map(user);
      },
      async createUser(input) {
        const outcome = await directory.createUser(input);
        return outcome.kind === 'email-taken'
          ? outcome
          : {
              kind: 'created',
              user: user(outcome.user),
              membership: membership(outcome.membership),
            };
      },
      async listMemberships() {
        return (await directory.listMemberships()).map(membership);
      },
      async findMembershipByPrincipal(principalId) {
        const row = await directory.findMembershipByPrincipal(principalId);
        return row === null ? null : membership(row);
      },
      async createMembership(input) {
        const outcome = await directory.createMembership(input);
        return outcome.kind === 'created'
          ? { kind: 'created', membership: membership(outcome.membership) }
          : outcome;
      },
      async changeMembershipRole(id, role) {
        const outcome = await directory.changeMembershipRole(id, role);
        return outcome.kind === 'changed'
          ? { kind: 'changed', membership: membership(outcome.membership) }
          : outcome;
      },
      deleteMembership: (id) => directory.deleteMembership(id),
      async listApiKeys() {
        return (await directory.listApiKeys()).map(apiKey);
      },
      async createApiKey(input) {
        const createdAt = now();
        let expiresAt: Date | null = null;
        if (input.expiresAt !== null) {
          expiresAt = new Date(input.expiresAt);
          if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= createdAt.getTime()) {
            return { kind: 'expiry-in-the-past', expiresAt: input.expiresAt };
          }
        }
        const minted = await mintApiKey();
        const outcome = await directory.createApiKey({
          name: input.name.trim(),
          role: input.role,
          keyPrefix: minted.keyPrefix,
          keyHash: minted.keyHash,
          expiresAt,
        });
        return outcome.kind === 'name-taken'
          ? outcome
          : { kind: 'created', key: apiKey(outcome.key), presented: minted.presented };
      },
      async revokeApiKey(id) {
        const outcome = await directory.revokeApiKey(id, now());
        if (outcome.kind === 'no-such-key') return outcome;
        if (outcome.kind === 'already-revoked') {
          return { kind: outcome.kind, key: apiKey(outcome.key) };
        }
        const scope = outcome.key.endpointScope;
        return {
          kind: outcome.kind,
          key: apiKey(outcome.key),
          mcpProjectClientId: scope?.kind === 'mcp-project' ? scope.clientId : null,
        };
      },
      async readStoredApiKey(id) {
        const row = await directory.readApiKey(id);
        return row === null ? null : storedApiKey(row);
      },
      async listInvitations() {
        return (await directory.listInvitations()).map(invitation);
      },
      async createInvitation(input) {
        const minted = await mintInvitationToken();
        const outcome = await directory.createInvitation({
          email: input.email,
          role: input.role,
          invitedBy: input.invitedBy,
          tokenHash: minted.tokenHash,
          expiresAt: new Date(now().getTime() + INVITATION_TTL_MS),
        });
        return outcome.kind === 'already-invited'
          ? outcome
          : { kind: 'created', invitation: invitation(outcome.invitation), token: minted.token };
      },
      async resendInvitation(id) {
        const minted = await mintInvitationToken();
        const outcome = await directory.resendInvitation(
          id,
          minted.tokenHash,
          new Date(now().getTime() + INVITATION_TTL_MS),
        );
        switch (outcome.kind) {
          case 'resent':
            return {
              kind: 'resent',
              invitation: invitation(outcome.invitation),
              token: minted.token,
            };
          case 'no-such-invitation':
            return outcome;
          case 'already-accepted':
          case 'revoked':
            return { kind: outcome.kind, invitation: invitation(outcome.invitation) };
          default: {
            const unreachable: never = outcome;
            throw new Error(`unhandled resendInvitation outcome ${JSON.stringify(unreachable)}`);
          }
        }
      },
      async revokeInvitation(id) {
        const outcome = await directory.revokeInvitation(id, now());
        switch (outcome.kind) {
          case 'no-such-invitation':
            return outcome;
          case 'revoked':
          case 'already-revoked':
          case 'already-accepted':
            return { kind: outcome.kind, invitation: invitation(outcome.invitation) };
          default: {
            const unreachable: never = outcome;
            throw new Error(`unhandled revokeInvitation outcome ${JSON.stringify(unreachable)}`);
          }
        }
      },
    };
  };

  return {
    forWorkspace,
    async authenticateApiKey(presented, at) {
      const parsed = parsePresentedKey(presented);
      if (parsed === null) return null;
      const row = await repository.authenticateApiKeyHash(
        await hashApiKeySecret(parsed.secret),
        at,
      );
      return row === null
        ? null
        : {
            principalId: row.principalId,
            apiKeyId: row.id,
            workspaceId: row.workspaceId,
            role: row.role,
            label: row.name,
            actsForPrincipalId: row.actsForPrincipalId,
            scope: tokenScopeOf(row.endpointScope),
          };
    },
    resolveRole: (email, workspaceId) => repository.resolveRole(email, workspaceId),
    async findUserByEmail(email) {
      const row = await repository.findUserByEmail(email);
      return row === null ? null : user(row);
    },
    findIdentity: (issuer, subject) => repository.findIdentity(issuer, subject),
    linkIdentity: (issuer, subject, userId) => repository.linkIdentity(issuer, subject, userId),
    membershipsForUser: (userId) => repository.membershipsForUser(userId),
    async acceptInvitation(id, token, identity) {
      const tokenHash = await hashInvitationToken(token);
      const outcome = await repository.acceptInvitation(id, tokenHash, identity, now());
      switch (outcome.kind) {
        case 'accepted':
          return {
            kind: 'accepted',
            workspaceId: outcome.workspaceId,
            workspaceSlug: outcome.workspaceSlug,
            user: user(outcome.user),
            membership: membership(outcome.membership),
          };
        case 'already-member':
          return {
            kind: 'already-member',
            workspaceId: outcome.workspaceId,
            userId: outcome.userId,
            principalId: outcome.principalId,
          };
        case 'invalid':
        case 'expired':
        case 'revoked':
        case 'already-accepted':
          return { kind: outcome.kind };
        default: {
          const unreachable: never = outcome;
          throw new Error(`unhandled acceptInvitation outcome ${JSON.stringify(unreachable)}`);
        }
      }
    },
  };
}
