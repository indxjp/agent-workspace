import { z } from 'zod';

import { DemoEntrySlugSchema } from './demo.js';
import { UuidSchema } from './identifiers.js';
import { USER_EMAIL_MAX_LENGTH } from './team.js';

/**
 * Email-link (passwordless) sign-in for the Agent Store's guests (spec §21, "Guest"), and the
 * store's lead form, the other request that keeps a visitor's address before any sign-in. A visitor
 * asks for a link at `POST /api/auth/email-link`; the link carries
 * a single-use secret; opening it posts the secret and the address to
 * `POST /api/auth/email-link/verify`, which binds the visitor as the guest of a demo workspace made
 * for them alone and sets the normal session cookie. Both answer in the ADR-0075 problem envelope.
 */

/** A link stays usable for fifteen minutes after it is sent, then it is refused. */
export const EMAIL_LINK_TTL_SECONDS = 15 * 60;

/**
 * The secret in a link: 32 random bytes, base64url without padding (43 characters), the same
 * entropy budget an invitation token has. Only its SHA-256 is stored.
 */
export const EMAIL_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

/**
 * A store visitor's address, trimmed and lower-cased, in the shape the `users` and `invitations`
 * tables check: something, `@`, something, a dot, something, with no whitespace. The email-link
 * sign-in and the store's lead form take the same shape.
 */
export const VisitorEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(USER_EMAIL_MAX_LENGTH)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u, 'must be an email address');

/**
 * The longest challenge answer accepted. A challenge provider's token is an opaque string of a few
 * kilobytes at most; anything longer is not one.
 */
export const EMAIL_LINK_CHALLENGE_MAX_LENGTH = 4096;

/** The visitor's answer to the sign-up challenge (CAPTCHA or an equivalent; the provider is configured). */
export const VisitorChallengeSchema = z.string().min(1).max(EMAIL_LINK_CHALLENGE_MAX_LENGTH);

/**
 * The visitor's tick on the consent box (internal spec, "Privacy notice and lead retention"): it
 * links the privacy notice and accepts the stated purpose. Every request that records a visitor's
 * address carries it, and a request without it is refused (`400 invalid_body`), so no address is
 * kept without consent.
 */
export const VisitorConsentSchema = z.literal(true);

/**
 * The body of `POST /api/auth/email-link`: the address to send a link to, the visitor's tick on
 * the consent box (`consent: true`; without it the request is `400 invalid_body` and nothing is
 * sent or kept), the visitor's answer to the sign-up challenge (CAPTCHA or an equivalent; the
 * provider is configured), and the catalog entry whose demo the visitor chose. The link carries
 * `entry` back, so opening it in another tab still provisions that demo.
 */
export const EmailLinkRequestSchema = z
  .object({
    email: VisitorEmailSchema,
    consent: VisitorConsentSchema,
    challenge: VisitorChallengeSchema,
    entry: DemoEntrySlugSchema.optional(),
  })
  .strict()
  .readonly();
export type EmailLinkRequest = z.infer<typeof EmailLinkRequestSchema>;

/**
 * The `202` of `POST /api/auth/email-link`. The same body whatever the address is (new, known, or
 * refused), so the answer never tells a caller whether an address has an account.
 */
export const EmailLinkIssuedResponseSchema = z
  .object({ status: z.literal('sent') })
  .strict()
  .readonly();
export type EmailLinkIssuedResponse = z.infer<typeof EmailLinkIssuedResponseSchema>;

/**
 * The body of `POST /api/auth/email-link/verify`: the address the link was sent to, the secret it
 * carried, and the catalog entry it named, if any. The address and the secret must match one
 * unused, unexpired link; `entry` names the demo the provisioner adds to the workspace.
 */
export const EmailLinkVerifyRequestSchema = z
  .object({
    email: VisitorEmailSchema,
    token: z.string().regex(EMAIL_LINK_TOKEN_PATTERN),
    entry: DemoEntrySlugSchema.optional(),
  })
  .strict()
  .readonly();
export type EmailLinkVerifyRequest = z.infer<typeof EmailLinkVerifyRequestSchema>;

/**
 * The `200` of `POST /api/auth/email-link/verify`, sent with the session cookie: the demo workspace
 * the guest is now signed in to. `created` is `false` when the address already had a demo
 * workspace younger than {@link DEMO_WORKSPACE_LIFETIME_SECONDS} and the link returned to it.
 */
export const EmailLinkVerifiedResponseSchema = z
  .object({
    workspaceId: UuidSchema,
    workspaceSlug: z.string().min(1),
    role: z.literal('guest'),
    created: z.boolean(),
  })
  .strict()
  .readonly();
export type EmailLinkVerifiedResponse = z.infer<typeof EmailLinkVerifiedResponseSchema>;

/** A demo workspace lasts 24 hours from when it was first made; a later link never extends it. */
export const DEMO_WORKSPACE_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * The refusals of the two routes and each one's HTTP status. `email_link_invalid` is one code for a
 * wrong, tampered, reused, expired or misaddressed link, so a caller cannot tell which.
 * `email_link_rate_limited` carries `Retry-After`. `email_link_unavailable` means this deployment
 * has no email sender, link base URL or challenge provider configured.
 * `email_link_challenge_failed` means the challenge answer was missing, wrong or expired.
 * `email_link_address_refused` means the address is on the disposable-email blocklist; it says
 * nothing about whether the address has an account. `demo_entry_unavailable` means no demo template
 * exists for the entry named; it is checked before a link is sent or consumed.
 */
export const EMAIL_LINK_PROBLEM_CODES = {
  invalid_body: 400,
  email_link_invalid: 400,
  email_link_challenge_failed: 403,
  demo_entry_unavailable: 404,
  email_link_address_refused: 422,
  email_link_rate_limited: 429,
  email_link_unavailable: 503,
} as const;
export type EmailLinkProblemCode = keyof typeof EMAIL_LINK_PROBLEM_CODES;

/** The longest enquiry message the store's form sends. */
export const STORE_ENQUIRY_MAX_LENGTH = 2000;

/** The most Customize-tab values one enquiry carries, and the longest of each name and value. */
export const STORE_ENQUIRY_SETUP_MAX_KEYS = 10;
export const STORE_ENQUIRY_SETUP_MAX_LENGTH = 200;

/**
 * The setup a visitor chose on an entry's "Install & customize" tab, sent with "Talk to us about
 * this setup" so sales sees the exact setup: the control's name (the catalog's
 * `CUSTOMIZE_CONTROLS`) to the chosen value.
 */
export const StoreEnquirySetupSchema = z
  .record(
    z.string().regex(/^[a-zA-Z]{1,40}$/u, 'must be a customize control name'),
    z.string().trim().max(STORE_ENQUIRY_SETUP_MAX_LENGTH),
  )
  .refine(
    (setup) => Object.keys(setup).length <= STORE_ENQUIRY_SETUP_MAX_KEYS,
    `at most ${String(STORE_ENQUIRY_SETUP_MAX_KEYS)} values`,
  );

/**
 * The body of `POST /api/store/leads`, the store's two forms that leave an address without signing
 * in. Both carry the visitor's consent and the challenge answer, and both are recorded as the
 * address's one `store_leads` row (its last contact moves to now):
 *
 * - `enquiry` — the enquiry form ("Talk to us"), optionally about one entry and with the setup
 *   chosen on its Customize tab. The message is kept as the lead's enquiry.
 * - `launch_notice` — "Notify me" on a coming-soon entry: the entry joins the lead's launch
 *   notices, so the visitor is told when it goes live.
 */
export const StoreLeadRequestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('enquiry'),
      email: VisitorEmailSchema,
      consent: VisitorConsentSchema,
      challenge: VisitorChallengeSchema,
      message: z.string().trim().min(1).max(STORE_ENQUIRY_MAX_LENGTH),
      entry: DemoEntrySlugSchema.optional(),
      setup: StoreEnquirySetupSchema.optional(),
    })
    .strict()
    .readonly(),
  z
    .object({
      kind: z.literal('launch_notice'),
      email: VisitorEmailSchema,
      consent: VisitorConsentSchema,
      challenge: VisitorChallengeSchema,
      entry: DemoEntrySlugSchema,
    })
    .strict()
    .readonly(),
]);
export type StoreLeadRequest = z.infer<typeof StoreLeadRequestSchema>;

/**
 * The `202` of `POST /api/store/leads`. The same body whether the address is new, known or
 * refused by the disposable-email check, so the answer never tells a caller which.
 */
export const StoreLeadReceivedResponseSchema = z
  .object({ status: z.literal('received') })
  .strict()
  .readonly();
export type StoreLeadReceivedResponse = z.infer<typeof StoreLeadReceivedResponseSchema>;

/**
 * The refusals of `POST /api/store/leads`, each with its HTTP status. They mirror the email-link
 * request's: a failed challenge is `403`, too many from one client is `429` with `Retry-After`,
 * and a deployment with no challenge provider configured answers `503 store_lead_unavailable`
 * (fail closed) rather than keeping an address it could not check.
 */
export const STORE_LEAD_PROBLEM_CODES = {
  invalid_body: 400,
  store_lead_challenge_failed: 403,
  store_lead_rate_limited: 429,
  store_lead_unavailable: 503,
} as const;
export type StoreLeadProblemCode = keyof typeof STORE_LEAD_PROBLEM_CODES;
