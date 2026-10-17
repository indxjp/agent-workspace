import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ownerPrincipalIdOf } from '../../rbac/owner-principal';
import type { CreateShareInput, ShareRecord } from '@agent-workspace/core/db';
import type { Role } from '../../rbac/roles';
import { isPublicSharingEnabled } from '../policy/service';
import type { WorkspaceSharing } from './runtime';
import { runnablePublicLinksEnabled } from '../runnable/feature';
import type { PublishShareInput } from './input';
import { DomainError } from '../../errors';

export type Expiry = '24 h' | '7 days' | '30 days' | 'never';
export type { PublishShareInput } from './input';
const EXPIRY_MS: Record<Exclude<Expiry, 'never'>, number> = {
  '24 h': 86_400_000,
  '7 days': 604_800_000,
  '30 days': 2_592_000_000,
};
function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('base64url')}.${scryptSync(passphrase, salt, 32).toString('base64url')}`;
}
function verifyPassphrase(passphrase: string, encoded: string): boolean {
  const [salt, expected] = encoded.split('.');
  if (!salt || !expected) return false;
  const actual = scryptSync(passphrase, Buffer.from(salt, 'base64url'), 32);
  const wanted = Buffer.from(expected, 'base64url');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
export class ShareService {
  public constructor(
    private readonly sharing: WorkspaceSharing,
    private readonly runnableEnabled = runnablePublicLinksEnabled(),
  ) {}
  async publish(
    input: PublishShareInput,
    actor: {
      principalId: string;
      ownerPrincipalId: string;
      userId: string | null;
      userLabel: string;
      role: Role;
    },
  ): Promise<ShareRecord> {
    if (!['agent', 'session', 'project', 'skill'].includes(input.subjectType))
      throw invalidShare(`Unsupported share subject type: ${String(input.subjectType)}`);
    if (input.visibility === 'public' && !(await isPublicSharingEnabled(this.sharing)))
      throw invalidShare('Public sharing is disabled for this workspace.');
    const mode = input.subjectType === 'agent' ? (input.mode ?? 'definition') : undefined;
    if (mode === 'runnable' && !this.runnableEnabled)
      throw invalidShare('Runnable public links are not available in this release (D-06).');
    if (mode === 'runnable' && !['owner', 'admin'].includes(actor.role))
      throw invalidShare('Runnable links require Admin or Owner.');
    const expiry = input.expiry ?? 'never';
    if (!['24 h', '7 days', '30 days', 'never'].includes(expiry))
      throw invalidShare(`Unsupported expiry: ${String(expiry)}`);
    const values: CreateShareInput = {
      token: `pub_${randomBytes(18).toString('base64url')}`,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel,
      visibility: input.visibility,
      mode,
      snapshot: input.snapshot,
      include: input.include ?? {},
      budgetCapUsd: mode === 'runnable' ? String(input.budgetCapUsd ?? 20) : null,
      expiresAt: expiry === 'never' ? null : new Date(Date.now() + EXPIRY_MS[expiry]),
      passphraseHash: input.passphrase ? hashPassphrase(input.passphrase) : null,
      publisherPrincipalId: ownerPrincipalIdOf(actor),
      createdBy: actor.userId,
    };
    const share = await this.sharing.shares.create(values);
    await this.sharing.audit.write({
      actorPrincipalId: actor.principalId,
      actorUserId: actor.userId,
      actorLabel: actor.userLabel,
      action: 'session-published',
      subjectId: share.id,
      subjectLabel: `${share.subjectLabel} (${share.visibility})`,
    });
    return share;
  }
  async resolve(token: string, passphrase?: string, visitorKey?: string): Promise<ShareRecord> {
    const share = await this.sharing.shares.findByToken(token);
    if (
      !share ||
      share.visibility !== 'public' ||
      share.revokedAt ||
      share.suspendedAt ||
      share.stopped
    )
      throw new DomainError({
        category: 'not-found',
        code: 'share_unavailable',
        publicMessage: 'Public link is unavailable.',
      });
    if (share.expiresAt && share.expiresAt.getTime() <= Date.now())
      throw new DomainError({
        category: 'not-found',
        code: 'share_unavailable',
        publicMessage: 'Public link is unavailable.',
      });
    if (
      share.passphraseHash &&
      (!passphrase || !verifyPassphrase(passphrase, share.passphraseHash))
    )
      throw new DomainError({
        category: 'forbidden',
        code: 'invalid_passphrase',
        publicMessage: 'The passphrase is incorrect.',
      });
    await this.sharing.views.record(share.id, visitorKey);
    return share;
  }
  async revoke(
    id: string,
    actor: { principalId: string; userId: string | null; userLabel: string },
  ): Promise<boolean> {
    const share = await this.sharing.shares.get(id);
    if (!share) return false;
    const revoked = await this.sharing.shares.revoke(id);
    if (revoked)
      await this.sharing.audit.write({
        actorPrincipalId: actor.principalId,
        actorUserId: actor.userId,
        actorLabel: actor.userLabel,
        action: 'public-link-revoked',
        subjectId: id,
        subjectLabel: share.subjectLabel,
      });
    return revoked;
  }
}

function invalidShare(publicMessage: string): DomainError {
  return new DomainError({
    category: 'validation',
    code: 'invalid_share',
    publicMessage,
  });
}
