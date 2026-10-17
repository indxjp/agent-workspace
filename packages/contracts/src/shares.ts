import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';

/** What a share publishes. Matches `shares.subject_type`. */
export const SHARE_SUBJECT_TYPES = ['agent', 'session', 'project', 'skill'] as const;
export type ShareSubjectType = (typeof SHARE_SUBJECT_TYPES)[number];

/**
 * Who may open a share. `public` mints a `/p/<token>` link and is refused while the workspace's
 * sharing policy has public sharing off (`400 invalid_share`).
 */
export const SHARE_VISIBILITIES = ['private', 'workspace', 'public'] as const;
export type ShareVisibility = (typeof SHARE_VISIBILITIES)[number];

/**
 * How an agent share behaves for its visitor. Only an agent share has a mode; the server defaults
 * it to `definition`. `runnable` is compiled off in this release and the server refuses it
 * (`400 invalid_share`); it stays in the vocabulary because the wire already names it.
 */
export const SHARE_MODES = ['definition', 'runnable'] as const;
export type ShareMode = (typeof SHARE_MODES)[number];

/** How long a share stays open, counted from publication. The server defaults to `never`. */
export const SHARE_EXPIRIES = ['24 h', '7 days', '30 days', 'never'] as const;
export type ShareExpiry = (typeof SHARE_EXPIRIES)[number];

/** The longest passphrase `POST /api/shares` accepts, in string code units. */
export const SHARE_PASSPHRASE_MAX_LENGTH = 1_024;

/**
 * Problem codes the shares routes own, with the status each one travels under. The common
 * vocabulary (`unauthenticated`, `forbidden`, …) is `COMMON_PROBLEM_CODES` at the package root.
 */
export const SHARES_PROBLEM_CODES = {
  /**
   * A body the route refuses: not JSON, a field outside the contract, an option the subject type
   * does not take, a `public` share while public sharing is off, or `runnable` mode.
   */
  invalid_share: 400,
  share_not_found: 404,
  shares_runtime_not_configured: 503,
} as const;

export type SharesProblemCode = keyof typeof SHARES_PROBLEM_CODES;

/**
 * What a session share reveals beyond the conversation. Meaningful only for a session share; the
 * server refuses it on any other subject and renders `{}` where none was given.
 */
export const ShareIncludeSchema = z
  .object({
    technicalDetails: z.boolean().optional(),
    outputFiles: z.boolean().optional(),
  })
  .strict()
  .readonly();

export type ShareInclude = z.infer<typeof ShareIncludeSchema>;

const shareFields = {
  id: z.string().min(1),
  subjectType: z.enum(SHARE_SUBJECT_TYPES),
  subjectId: z.string().min(1),
  subjectLabel: z.string().min(1),
  visibility: z.enum(SHARE_VISIBILITIES),
  /** `null` for every subject but an agent. */
  mode: z.enum(SHARE_MODES).nullable(),
  /** The server-held document a visitor is shown; `null` when the share carries none. */
  snapshot: z.unknown(),
  include: ShareIncludeSchema,
  /** A decimal string; `null` unless the share is a runnable agent. */
  budgetCapUsd: z.string().min(1).nullable(),
  /** A decimal string: what visitors of a runnable share have spent so far. */
  spentUsd: z.string().min(1),
  /** `true` once the budget was exhausted; the link no longer runs. */
  stopped: z.boolean(),
  expiresAt: IsoDateTimeSchema.nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
  suspendedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
  /**
   * The public link, relative to the API origin (`/p/<token>`). Present exactly when
   * `visibility` is `public`: the token of a private or workspace share never crosses the wire.
   */
  url: z.string().startsWith('/p/').optional(),
};

const PUBLIC_URL_INVARIANT = {
  check: (share: { readonly visibility: ShareVisibility; readonly url?: string | undefined }) =>
    (share.url !== undefined) === (share.visibility === 'public'),
  message: 'url is present exactly when visibility is public',
};

/**
 * One share as the `201` of `POST /api/shares` renders it (bare, not wrapped). Dates are
 * ISO-8601 strings; money is decimal strings.
 */
export const ShareResourceSchema = z
  .object(shareFields)
  .strict()
  .refine(PUBLIC_URL_INVARIANT.check, { message: PUBLIC_URL_INVARIANT.message })
  .readonly();

export type ShareResource = z.infer<typeof ShareResourceSchema>;

/** Every item of `GET /api/shares`: the share plus how many times it has been opened. */
export const ShareListItemSchema = z
  .object({ ...shareFields, viewCount: z.number().int().nonnegative() })
  .strict()
  .refine(PUBLIC_URL_INVARIANT.check, { message: PUBLIC_URL_INVARIANT.message })
  .readonly();

export type ShareListItem = z.infer<typeof ShareListItemSchema>;

/**
 * The body of `GET /api/shares`: the caller's own shares, or every share of the workspace for an
 * Owner or Admin.
 */
export const ShareListResponseSchema = z
  .object({ shares: z.array(ShareListItemSchema).readonly() })
  .strict()
  .readonly();

export type ShareListResponse = z.infer<typeof ShareListResponseSchema>;

/**
 * The body of `POST /api/shares`.
 *
 * `mode` and `budgetCapUsd` are for an agent share only (`budgetCapUsd` further requires
 * `runnable` mode); `include` is for a session share only. The route refuses any other pairing
 * as `400 invalid_share`, so the SDK sends the command as given rather than guessing.
 *
 * `subjectLabel` is client-authored until RF-103, when the server derives it from the subject:
 * the route requires it today and stores it verbatim. The share's content (`snapshot`) is
 * likewise server-owned; this command never carries a transcript, a definition or a snapshot.
 */
export interface PublishShareCommand {
  readonly subjectType: ShareSubjectType;
  readonly subjectId: string;
  readonly subjectLabel: string;
  readonly visibility: ShareVisibility;
  readonly mode?: ShareMode;
  readonly include?: ShareInclude;
  readonly expiry?: ShareExpiry;
  /** At most {@link SHARE_PASSPHRASE_MAX_LENGTH} code units; hashed at rest, never returned. */
  readonly passphrase?: string;
  /** A positive amount in USD; the server defaults a runnable share to 20. */
  readonly budgetCapUsd?: number;
}
