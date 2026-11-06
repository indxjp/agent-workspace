/**
 * The share use cases: publish, resolve and revoke. The rules are in `./core/rules.ts`; this file
 * reads the facts they need (the time, the workspace's policy), mints the token and the passphrase
 * hash, writes through the `WorkspaceSharing` port, and turns a refusal into the HTTP error.
 */
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { systemClock, type Clock } from '../clock';
import { ownerPrincipalIdOf } from '../rbac/core/owner-principal';
import type { CreateShareInput, ShareRecord } from './store';
import type { Role } from '../rbac/core/roles';
import { isPublicSharingEnabled } from './policy/service';
import type { WorkspaceSharing } from './runtime';
import { runnablePublicLinksEnabled } from './runnable/feature';
import type { PublishShareInput } from './core/input';
import { decidePublish, publicLinkOpen } from './core/rules';
import { DomainError } from '../errors';

export type { Expiry } from './core/rules';
export type { PublishShareInput } from './core/input';
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
    private readonly clock: Clock = systemClock,
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
    const decision = decidePublish(input, {
      role: actor.role,
      // The policy is read only for a public share, the one kind it decides.
      publicSharingEnabled:
        input.visibility === 'public' && (await isPublicSharingEnabled(this.sharing)),
      runnableEnabled: this.runnableEnabled,
      now: this.clock.now(),
    });
    if (!decision.ok) throw invalidShare(decision.message);
    const values: CreateShareInput = {
      token: `pub_${randomBytes(18).toString('base64url')}`,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectLabel: input.subjectLabel,
      visibility: input.visibility,
      mode: decision.mode,
      snapshot: input.snapshot,
      include: input.include ?? {},
      budgetCapUsd: decision.budgetCapUsd,
      expiresAt: decision.expiresAt,
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
    if (!share || !publicLinkOpen(share, this.clock.now()))
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
