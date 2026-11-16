import type {
  IssueOAuthTokenInput,
  OAuthConsumeOutcome,
  OAuthTokenRepository,
} from '@agent-workspace/core/db';
export interface Row extends IssueOAuthTokenInput {
  usedAt: Date | null;
  revokedAt: Date | null;
}

export function fakeTokens(rows: Row[]): OAuthTokenRepository {
  const live = (row: Row): boolean =>
    row.revokedAt === null && row.expiresAt.getTime() > Date.now();
  return {
    issue: (input) => {
      rows.push({ ...input, usedAt: null, revokedAt: null });
      return Promise.resolve();
    },
    issueExchanged: (input) => {
      rows.push({ ...input, usedAt: null, revokedAt: null });
      return Promise.resolve();
    },
    consume: (kind, tokenHash, clientId): Promise<OAuthConsumeOutcome> => {
      const row = rows.find(
        (r) => r.kind === kind && r.tokenHash === tokenHash && r.clientId === clientId,
      );
      if (row === undefined || !live(row)) return Promise.resolve({ kind: 'invalid' });
      if (row.usedAt !== null) {
        return Promise.resolve({
          kind: 'reused',
          familyId: row.familyId,
          subjectPrincipalId: row.subjectPrincipalId,
        });
      }
      row.usedAt = new Date();
      return Promise.resolve({
        kind: 'consumed',
        token: {
          id: row.id,
          clientId: row.clientId,
          kind: row.kind,
          subjectPrincipalId: row.subjectPrincipalId,
          resource: row.resource,
          familyId: row.familyId,
          codeChallenge: row.codeChallenge ?? null,
          redirectUri: row.redirectUri ?? null,
        },
      });
    },
    revokeFamily: (familyId) => {
      const open = rows.filter((r) => r.familyId === familyId && r.revokedAt === null);
      for (const row of open) row.revokedAt = new Date();
      return Promise.resolve(open.length);
    },
    revoke: (tokenHash, clientId) => {
      const row = rows.find(
        (r) =>
          r.tokenHash === tokenHash &&
          r.clientId === clientId &&
          (r.kind === 'access' || r.kind === 'refresh') &&
          r.revokedAt === null,
      );
      if (row === undefined) return Promise.resolve(null);
      const family = row.kind === 'refresh';
      for (const r of rows) {
        if (family ? r.familyId === row.familyId : r === row) r.revokedAt ??= new Date();
      }
      return Promise.resolve({
        kind: row.kind,
        familyId: row.familyId,
        subjectPrincipalId: row.subjectPrincipalId,
      });
    },
  };
}
