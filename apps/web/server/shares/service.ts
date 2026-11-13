/**
 * The share use cases: publish, resolve and revoke. The rules are in `./core/rules.ts`; this file
 * reads the facts they need (the time, the workspace's policy), mints the token and the passphrase
 * hash, writes through the `WorkspaceSharing` port, and turns a refusal into the HTTP error.
 */
import { randomBytes } from 'node:crypto';

import { systemClock, type Clock } from '../clock';
import { ownerPrincipalIdOf, type Role } from '../identity';
import type { CreateShareInput, ShareRecord } from './store';
import { isPublicSharingEnabled } from './policy/service';
import type { WorkspaceSharing } from './runtime';
import { runnablePublicLinksEnabled } from './runnable/feature';
import type { PublishShareInput } from './core/input';
import { decidePublish, publicLinkOpen } from './core/rules';
import { hashShareToken } from './link-token';
import { DomainError } from '../errors';
import { hashPassphrase, PassphraseAttemptLimiter, verifyPassphrase } from './passphrase';

export type { Expiry } from './core/rules';
export type { PublishShareInput } from './core/input';

/** Who publishes a share. */
interface PublishActor {
  principalId: string;
  ownerPrincipalId: string;
  userId: string | null;
  userLabel: string;
  role: Role;
}

/** Who revokes a share. */
type RevokeActor = Pick<PublishActor, 'principalId' | 'userId' | 'userLabel'>;

/** The audit actor fields every share event carries. */
const auditActor = (actor: RevokeActor) => ({
  actorPrincipalId: actor.principalId,
  actorUserId: actor.userId,
  actorLabel: actor.userLabel,
});

/** The link token a share is published under; shown once, only its hash is stored. */
const newLinkToken = (): string => `pub_${randomBytes(18).toString('base64url')}`;
const passphraseAttempts = new PassphraseAttemptLimiter();
/** A new share and its link token, which is not stored and so can be shown only now. */
export interface PublishedShare {
  readonly share: ShareRecord;
  readonly token: string;
}

export class ShareService {
  public constructor(
    private readonly sharing: WorkspaceSharing,
    private readonly runnableEnabled = runnablePublicLinksEnabled(),
    private readonly clock: Clock = systemClock,
    private readonly attempts: PassphraseAttemptLimiter = passphraseAttempts,
  ) {}
  async publish(input: PublishShareInput, actor: PublishActor): Promise<PublishedShare> {
    const decision = decidePublish(input, {
      role: actor.role,
      // The policy is read only for a public share, the one kind it decides.
      publicSharingEnabled:
        input.visibility === 'public' && (await isPublicSharingEnabled(this.sharing)),
      runnableEnabled: this.runnableEnabled,
      now: this.clock.now(),
    });
    if (!decision.ok) throw invalidShare(decision.message);
    // Shown once, in the publish response; only its hash is stored (part 06 step 3 phase 2).
    const token = newLinkToken();
    const values: CreateShareInput = {
      tokenHash: await hashShareToken(token),
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
      ...auditActor(actor),
      action: 'session-published',
      subjectId: share.id,
      subjectLabel: `${share.subjectLabel} (${share.visibility})`,
    });
    return { share, token };
  }
  /** The share a link token names, found by the token's hash (part 06 step 3), or `null`. */
  async findByToken(token: string): Promise<ShareRecord | null> {
    return this.sharing.shares.findByTokenHash(await hashShareToken(token));
  }

  async resolve(token: string, passphrase?: string, visitorKey?: string): Promise<ShareRecord> {
    const share = await this.findByToken(token);
    if (!share || !publicLinkOpen(share, this.clock.now()))
      throw new DomainError({
        category: 'not-found',
        code: 'share_unavailable',
        publicMessage: 'Public link is unavailable.',
      });
    if (share.passphraseHash) await this.#checkPassphrase(share, passphrase, visitorKey);
    await this.sharing.views.record(share.id, visitorKey);
    return share;
  }
  async #checkPassphrase(
    share: ShareRecord,
    passphrase: string | undefined,
    visitorKey: string | undefined,
  ): Promise<void> {
    // Opening a protected link without a passphrase asks for one; it is not a guess, so it is
    // neither limited nor counted (otherwise plain page loads would lock the link).
    if (!passphrase) throw invalidPassphrase();
    const nowMs = this.clock.now().getTime();
    const retryAfterSeconds = this.attempts.reserve(share.id, visitorKey, nowMs);
    if (retryAfterSeconds !== null)
      throw new DomainError({
        category: 'rate-limit',
        code: 'passphrase_attempts_limited',
        publicMessage: 'Too many incorrect passphrases; try again later.',
        retryAfterSeconds,
      });
    try {
      if (share.passphraseHash && (await verifyPassphrase(passphrase, share.passphraseHash)))
        return;
    } finally {
      this.attempts.release(share.id);
    }
    this.attempts.recordFailure(share.id, visitorKey, nowMs);
    throw invalidPassphrase();
  }
  async revoke(id: string, actor: RevokeActor): Promise<boolean> {
    const share = await this.sharing.shares.get(id);
    if (!share) return false;
    const revoked = await this.sharing.shares.revoke(id);
    if (revoked)
      await this.sharing.audit.write({
        ...auditActor(actor),
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

/** The refusal for a missing or wrong passphrase on a protected link. */
function invalidPassphrase(): DomainError {
  return new DomainError({
    category: 'forbidden',
    code: 'invalid_passphrase',
    publicMessage: 'The passphrase is incorrect.',
  });
}
