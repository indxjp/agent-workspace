import { z } from 'zod';

/**
 * The one error envelope every failing `/api/**` route returns.
 *
 * `code` is the stable, machine-readable part of the contract: a client branches on it, never on
 * `message`. `message` is deliberately safe prose the server chose for the client; it never carries
 * a raw provider, SQL, filesystem or credential-bearing text. `details` is present only when there
 * is more to say than the message — per-field parse errors, for example.
 *
 * `detail` is the spelling the RBAC layer used before this envelope became the only one. The server
 * still renders it, always equal to `message`, so a reader written against the old spelling keeps
 * working until the next major release (ADR-0078 D7); a client reads `message`.
 */
export const ApiProblemSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        message: z.string(),
        details: z.array(z.string()).readonly().optional(),
        /** @deprecated A duplicate of `message`, removed in the release after SDK unit 6 (#238). */
        detail: z.string().optional(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

export type ApiProblem = z.infer<typeof ApiProblemSchema>;

/**
 * The envelope a deployment older than SDK unit 6 (#238) answers with, where the prose field is
 * named `detail` rather than `message`. The RBAC layer — the team routes and every `401`, `403`,
 * `500 authorisation_undecidable` and `503 rbac_runtime_not_configured` refused before a domain
 * handler runs — rendered it. Current servers answer {@link ApiProblemSchema} instead, so this
 * schema no longer describes a live answer; it stays published so the SDK can still read the
 * stable `code` from an older deployment, mapping `detail` onto `message`.
 */
export const ApiProblemDetailSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1),
        detail: z.string(),
      })
      .strict()
      .readonly(),
  })
  .strict()
  .readonly();

/**
 * The envelope one route still answers with, where `error` is the bare code: `POST
 * /api/runtimes/test` (`{ error, message }`). Published for the same reason as
 * {@link ApiProblemDetailSchema}; the route converges on {@link ApiProblemSchema} through server
 * change S-4 (spec 04 §8). A deployment older than SDK unit 6 (#238) also answered `GET
 * /api/audit-events` this way.
 */
export const ApiProblemBareCodeSchema = z
  .object({
    error: z.string().min(1),
    message: z.string().optional(),
  })
  .strict()
  .readonly();

/**
 * Problem codes shared by every domain, with the status each one travels under.
 *
 * Domain-owned codes (`agent_not_found`, `session_not_usable`, `project_archived`, …) stay with
 * their domain module; this table is only the vocabulary a caller meets on every route.
 */
export const COMMON_PROBLEM_CODES = {
  unauthenticated: 401,
  forbidden: 403,
  authorisation_undecidable: 500,
  malformed_body: 400,
  invalid_body: 400,
  unsupported_media_type: 415,
  request_body_too_large: 413,
  internal_error: 500,
  service_unavailable: 503,
  upstream_failure: 502,
} as const;

export type CommonProblemCode = keyof typeof COMMON_PROBLEM_CODES;

/**
 * What can hold a reference that keeps a resource from being deleted. A delete of a referenced
 * resource is refused, never cascaded, and never left to orphan the referrer (ADR-0077).
 */
export const IN_USE_REFERRER_KINDS = [
  'agent',
  'connector',
  'model-connection',
  'storage-connection',
] as const;
export type InUseReferrerKind = (typeof IN_USE_REFERRER_KINDS)[number];

/** One referrer, as the `details` of a `409 <resource>_in_use` problem carries it. */
export interface InUseReferrer {
  readonly kind: InUseReferrerKind;
  readonly id: string;
}

const IN_USE_REFERRER_PATTERN =
  /^(agent|connector|model-connection|storage-connection):([0-9a-f-]{36})$/u;

/**
 * The one naming rule for "refused while referenced": the code is `<resource>_in_use`, the status
 * is `409`, and `details` lists every referrer as `<kind>:<id>` (`agent:3f…`), sorted. The caller
 * removes those references and retries; nothing is deleted while any remains.
 */
export function formatInUseReferrer(referrer: InUseReferrer): string {
  return `${referrer.kind}:${referrer.id}`;
}

/** Read the referrers back out of a `409 <resource>_in_use` problem's `details`. */
export function parseInUseReferrers(details: readonly string[]): readonly InUseReferrer[] {
  const referrers: InUseReferrer[] = [];
  for (const detail of details) {
    const match = IN_USE_REFERRER_PATTERN.exec(detail);
    const kind = match?.[1];
    const id = match?.[2];
    if (kind === undefined || id === undefined) continue;
    referrers.push({ kind: kind as InUseReferrerKind, id });
  }
  return referrers;
}
