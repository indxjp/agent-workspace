/**
 * The email-link sign-in's ports (spec §21, "Guest").
 *
 * The domain follows the Builder's layout (AGENTS.md, hexagonal rule 1): the rules in `core/` (no
 * I/O), these ports, one folder per port under `adapters/` with a production and a memory adapter
 * and one contract test run against both, and the wiring in `transport/composition.ts`. Time comes
 * from the `Clock` and row ids from the `IdGenerator`; the link's secret comes from `node:crypto`
 * inside an adapter, never from either of them.
 *
 * A link is sent to an address; opening it consumes it and binds the visitor as the `guest` of a
 * demo workspace made for that address alone. The demo provisioner (P3) fills that workspace; this
 * domain only makes it and binds the guest, through {@link GuestWorkspaceBinder}.
 */
import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';
import type {
  EmailLinkIssuedResponse,
  EmailLinkProblemCode,
  EmailLinkVerifiedResponse,
} from '@indx-workspace/contracts/email-link';

/** One link as it is stored: hashes and times only, never the secret or the address. */
export interface LoginTokenRecord {
  readonly id: string;
  /** SHA-256 of the link's secret, lower-case hex. */
  readonly tokenHash: string;
  /** SHA-256 of the lower-cased address, lower-case hex. */
  readonly emailHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** What consuming a link found. Every refusal is one answer, so a caller cannot tell them apart. */
export type ConsumeOutcome = { readonly kind: 'consumed' } | { readonly kind: 'refused' };

/** The `login_tokens` table. PostgreSQL in production, memory in tests; one contract test for both. */
export interface LoginTokenStore {
  /**
   * Store a newly issued link if fewer than `limit` links were issued to its `emailHash` at or
   * after `since`: the per-address issue limit. Counting and storing are one atomic step, so any
   * number of concurrent calls for one address, from any number of clients, store at most `limit`
   * rows between them. `true` when the link was stored, `false` when the limit held.
   */
  reserve(
    record: LoginTokenRecord,
    window: { readonly since: Date; readonly limit: number },
  ): Promise<boolean>;
  /** Remove a reserved link that could not be sent, so it does not count against the limit. */
  release(id: string): Promise<void>;
  /**
   * Mark the link used, atomically, if and only if a row has this `tokenHash` and this
   * `emailHash`, is unused and expires after `now`. A reused, expired, tampered or misaddressed
   * link, and a second of two concurrent opens, answer `refused` and change nothing.
   */
  consume(input: {
    readonly tokenHash: string;
    readonly emailHash: string;
    readonly now: Date;
  }): Promise<ConsumeOutcome>;
}

/** One sign-in link to send. `link` holds the secret; it exists only for this call. */
export interface EmailLinkMessage {
  readonly to: string;
  readonly link: string;
  readonly expiresAt: Date;
}

/**
 * Sends the link. The production sender is configured, and its provider is an open human decision
 * (spec §08, "Email sender"); tests use the fake adapter, which records messages and sends nothing.
 */
export interface EmailLinkSender {
  send(message: EmailLinkMessage): Promise<void>;
}

/** What the sign-up challenge made of an answer. */
export type ChallengeVerdict = 'pass' | 'fail';

/**
 * The sign-up challenge (CAPTCHA or an equivalent): checks the answer a visitor's browser got from
 * the challenge provider. The provider is an open human decision (spec §08), so the production
 * adapter is chosen by `AW_EMAIL_LINK_CHALLENGE`; tests use the fake adapter. `headers` are the
 * request's, for a provider that wants the client address. A provider that cannot be reached is a
 * `fail`: the sign-up fails closed.
 */
export interface ChallengeVerifier {
  verify(answer: string, headers: Headers): Promise<ChallengeVerdict>;
}

/**
 * The disposable-email blocklist: a checked-in list of domains, consulted in-process with no
 * network. A domain on the list and every subdomain of it is disposable.
 */
export interface DisposableEmailList {
  isDisposable(address: string): boolean;
}

/** The demo workspace a guest is bound to. */
export interface GuestBinding {
  readonly userId: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  /** `false` when the address already had a demo workspace younger than its lifetime. */
  readonly created: boolean;
}

/**
 * The binding seam (P2) the demo provisioner (P3) builds on. For an address whose link was just
 * consumed: find or create the user; return the guest's existing demo workspace if it was made less
 * than `DEMO_WORKSPACE_LIFETIME_SECONDS` before `now`; otherwise make a new workspace and give the
 * user a `guest` membership in it, in one transaction. It never touches a membership the user holds
 * in any other workspace, and never writes a role but `guest`. `null` when the address already
 * holds a membership with any other role: a real account signs in through its identity provider,
 * never by link, so a link session can never reach a real workspace.
 *
 * P3: the demo provisioner (`../demo/provision/`) is the production binder. It marks a new
 * workspace with its end (`workspaces.demo_expires_at`), adds `entry`'s demo agent and sample data
 * to the workspace (new or returned to) and records the lead. {@link GuestWorkspaceBinder.hasEntry}
 * lets the sign-in refuse an entry with no demo before it sends or consumes a link.
 */
export interface GuestWorkspaceBinder {
  bind(input: {
    readonly email: string;
    readonly now: Date;
    /** The catalog entry whose demo the visitor chose; absent binds the workspace alone. */
    readonly entry?: DemoEntrySlug;
  }): Promise<GuestBinding | null>;
  /** Whether `entry` has a demo template to provision. */
  hasEntry(entry: DemoEntrySlug): Promise<boolean>;
}

/** A refusal, as the routes answer it. `retryAfterSeconds` is set exactly for the rate limit. */
export interface EmailLinkRefusal {
  readonly kind: 'refused';
  readonly code: EmailLinkProblemCode;
  readonly retryAfterSeconds?: number;
}

/**
 * The use cases the routes call. `headers` identify the client for the per-IP limits
 * (`http/rate-limit.ts`'s `admitClient`).
 */
export interface EmailLinkService {
  /** Send a link. The same `sent` answer for a new, a known and a refused address. */
  issue(input: {
    readonly email: string;
    /** The visitor's answer to the sign-up challenge. */
    readonly challenge: string;
    /** The catalog entry whose demo the visitor chose; the link carries it back. */
    readonly entry?: DemoEntrySlug;
    readonly headers: Headers;
  }): Promise<
    { readonly kind: 'issued'; readonly body: EmailLinkIssuedResponse } | EmailLinkRefusal
  >;
  /** Consume a link and bind its guest. The route sets the session cookie for the binding. */
  verify(input: {
    readonly email: string;
    readonly token: string;
    readonly entry?: DemoEntrySlug;
    readonly headers: Headers;
  }): Promise<
    | {
        readonly kind: 'verified';
        readonly body: EmailLinkVerifiedResponse;
        readonly binding: GuestBinding;
        readonly email: string;
      }
    | EmailLinkRefusal
  >;
}
