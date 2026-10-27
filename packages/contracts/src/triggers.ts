import { z } from 'zod';

import { IsoDateTimeSchema, UuidSchema } from './identifiers.js';
import { IDENTITY_SUBJECT_MAX_LENGTH } from './identity-assertion.js';
import { NAME_KEY_PATTERN } from './project-file.js';
import { MAX_PROMPT_CHARS, outputSchemaViolation } from './runs.js';

/**
 * What starts a run without a person at the keyboard (ADR-0144): a `webhook` is a URL whose secret
 * is the whole authentication of the ingress, a `schedule` is a cron expression read in a time zone.
 */
export const TRIGGER_KINDS = ['webhook', 'schedule'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** The only substitution a trigger's prompt template has (ADR-0144 D1). */
export const TRIGGER_BODY_PLACEHOLDER = '{{body}}';

/** The largest request body a firing accepts, in bytes (ADR-0144 D2 limit 1). */
export const TRIGGER_MAX_BODY_BYTES = 256 * 1024;

/** The most firings one trigger accepts in a minute (ADR-0144 D2 limit 2). */
export const TRIGGER_RATE_PER_MINUTE = 30;

/** The most unfinished runs one trigger has at a time (ADR-0144 D2 limit 3). */
export const TRIGGER_MAX_CONCURRENT_RUNS = 3;

/** The longest `Idempotency-Key` a firing accepts; the same bound as the storage column. */
export const TRIGGER_IDEMPOTENCY_KEY_MAX_LENGTH = 255;

/** The longest Microsoft Graph `validationToken` the ingress echoes. */
export const TRIGGER_VALIDATION_TOKEN_MAX_LENGTH = 1024;

/** The longest Zoom app secret token a trigger stores. */
export const TRIGGER_ZOOM_SECRET_TOKEN_MAX_LENGTH = 256;

/** The `event` of Zoom's endpoint URL validation request. */
export const ZOOM_URL_VALIDATION_EVENT = 'endpoint.url_validation';

const PLACEHOLDER_PATTERN = /\{\{[\s\S]*?\}\}/gu;

/**
 * Why `template` is not a valid prompt template, or `null`. Any `{{…}}` other than
 * {@link TRIGGER_BODY_PLACEHOLDER} is refused rather than left in the prompt as literal text.
 */
export function findTriggerTemplateError(template: string): string | null {
  for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
    if (match[0] !== TRIGGER_BODY_PLACEHOLDER) {
      return `${match[0]} is not a substitution; the only one is ${TRIGGER_BODY_PLACEHOLDER}`;
    }
  }
  return null;
}

/**
 * The prompt of one firing: every `{{body}}` replaced by the request body, verbatim. The body is
 * untrusted text that is substituted and never interpreted, so the replacement is a function (a
 * string would read `$&` and `$1` in it as patterns).
 */
export function renderTriggerPrompt(template: string, body: string): string {
  return template.replaceAll(TRIGGER_BODY_PLACEHOLDER, () => body);
}

const TriggerNameSchema = z.string().regex(NAME_KEY_PATTERN, 'must be lower-case kebab');

const TriggerPromptSchema = z
  .string()
  .min(1)
  .max(MAX_PROMPT_CHARS)
  .refine((template) => findTriggerTemplateError(template) === null, {
    error: (issue) =>
      typeof issue.input === 'string'
        ? (findTriggerTemplateError(issue.input) ?? 'invalid template')
        : 'invalid template',
  });

/**
 * The JSON Schema every run a trigger starts is asked to answer in (ADR-0154): the same object, and
 * the same limits, as `StartRunRequest.outputSchema` (ADR-0143).
 */
export const TriggerOutputSchemaSchema = z
  .record(z.string(), z.unknown())
  .superRefine((schema, context) => {
    const found = outputSchemaViolation(schema);
    if (found !== null) context.addIssue({ code: 'custom', message: found.message });
  });

/**
 * The caller every run a trigger starts acts for (ADR-0156): validated like `StartRunRequest.subject`
 * and forwarded to each run it starts; a webhook body never overrides it.
 */
const TriggerSubjectSchema = z.string().min(1).max(IDENTITY_SUBJECT_MAX_LENGTH);

const ZoomSecretTokenSchema = z.string().min(1).max(TRIGGER_ZOOM_SECRET_TOKEN_MAX_LENGTH);

/**
 * One trigger as every item of `GET /api/triggers` and the body of the single routes render it.
 * `hasSecret` and `hasZoomSecretToken` say whether the credential is set; neither is ever returned.
 * `outputSchema` is the schema its runs answer in, or `null` when they are untyped (ADR-0154).
 * `subject` is the caller its runs act for, or `null` when they have none (ADR-0156).
 */
export const TriggerResourceSchema = z
  .object({
    id: UuidSchema,
    name: TriggerNameSchema,
    kind: z.enum(TRIGGER_KINDS),
    agentId: UuidSchema,
    prompt: z.string(),
    cron: z.string().min(1).nullable(),
    timezone: z.string().min(1).nullable(),
    enabled: z.boolean(),
    outputSchema: TriggerOutputSchemaSchema.nullable(),
    subject: TriggerSubjectSchema.nullable(),
    ownerPrincipalId: UuidSchema,
    hasSecret: z.boolean(),
    hasZoomSecretToken: z.boolean(),
    lastFiredAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

export type TriggerResource = z.infer<typeof TriggerResourceSchema>;

const CreateTriggerBaseShape = {
  name: TriggerNameSchema,
  agentId: UuidSchema,
  prompt: TriggerPromptSchema,
  enabled: z.boolean().optional(),
  outputSchema: TriggerOutputSchemaSchema.optional(),
  subject: TriggerSubjectSchema.optional(),
};

/**
 * The body of `POST /api/triggers`. A `schedule` trigger needs a five-field `cron` expression and an
 * IANA `timezone`; the server answers `400 invalid_field` for one it cannot parse.
 */
export const CreateTriggerRequestSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('webhook'),
        ...CreateTriggerBaseShape,
        zoomSecretToken: ZoomSecretTokenSchema.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('schedule'),
        ...CreateTriggerBaseShape,
        cron: z.string().min(1).max(256),
        timezone: z.string().min(1).max(64),
      })
      .strict(),
  ])
  .readonly();

export type CreateTriggerRequest = z.infer<typeof CreateTriggerRequestSchema>;

/**
 * The body of `PATCH /api/triggers/:id`. `zoomSecretToken` is write-only; `null` clears it, and the
 * server refuses it on a `schedule` trigger. `outputSchema` replaces the trigger's schema; `null`
 * clears it (ADR-0154). `subject` replaces the caller its runs act for; `null` clears it (ADR-0156).
 */
export const UpdateTriggerRequestSchema = z
  .object({
    name: TriggerNameSchema.optional(),
    prompt: TriggerPromptSchema.optional(),
    enabled: z.boolean().optional(),
    zoomSecretToken: ZoomSecretTokenSchema.nullable().optional(),
    outputSchema: TriggerOutputSchemaSchema.nullable().optional(),
    subject: TriggerSubjectSchema.nullable().optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'send name, prompt, enabled, zoomSecretToken, outputSchema, subject or any of them',
  })
  .readonly();

export type UpdateTriggerRequest = z.infer<typeof UpdateTriggerRequestSchema>;

export const TriggerResponseSchema = z
  .object({ trigger: TriggerResourceSchema })
  .strict()
  .readonly();

export type TriggerResponse = z.infer<typeof TriggerResponseSchema>;

export const TriggerListResponseSchema = z
  .object({ triggers: z.array(TriggerResourceSchema).readonly() })
  .strict()
  .readonly();

export type TriggerListResponse = z.infer<typeof TriggerListResponseSchema>;

/**
 * The answer of `POST /api/triggers` and `POST /api/triggers/:id/secret`: the URL secret, shown
 * once, and the path a sender calls. The secret travels in that path because Microsoft Graph and
 * Zoom can only call a fixed URL (ADR-0144 D2); a URL can land in access logs of a proxy or CDN
 * outside this platform's control, so rotate the secret if one may have leaked. A `schedule`
 * trigger has no secret.
 */
export const TriggerSecretResponseSchema = z
  .object({
    trigger: TriggerResourceSchema,
    secret: z.string().min(1),
    firePath: z.string().min(1),
    warning: z.string().min(1),
  })
  .strict()
  .readonly();

export type TriggerSecretResponse = z.infer<typeof TriggerSecretResponseSchema>;

/** The answer of `POST /api/triggers`: the secret for a `webhook`, just the trigger for a `schedule`. */
export const CreateTriggerResponseSchema = z
  .union([TriggerSecretResponseSchema, TriggerResponseSchema])
  .readonly();

export type CreateTriggerResponse = z.infer<typeof CreateTriggerResponseSchema>;

/** Zoom's `endpoint.url_validation` request, as much of it as the ingress reads. */
export const ZoomUrlValidationEventSchema = z
  .object({
    event: z.literal(ZOOM_URL_VALIDATION_EVENT),
    payload: z.object({ plainToken: z.string().min(1) }),
  })
  .readonly();

/** The answer to Zoom's URL validation: the token and its HMAC-SHA256 (hex) under the app secret. */
export const ZoomUrlValidationResponseSchema = z
  .object({ plainToken: z.string().min(1), encryptedToken: z.string().min(1) })
  .strict()
  .readonly();

export type ZoomUrlValidationResponse = z.infer<typeof ZoomUrlValidationResponseSchema>;

/**
 * Domain problem codes of the trigger routes, with the status each travels under. Every miss on the
 * public fire route is the one `trigger_not_found` (ADR-0144 D2), so a caller cannot learn whether a
 * trigger exists.
 */
export const TRIGGER_PROBLEM_CODES = {
  trigger_not_found: 404,
  trigger_name_taken: 409,
  trigger_agent_not_runnable: 403,
  trigger_not_webhook: 409,
  trigger_owner_not_allowed: 403,
  trigger_subject_not_allowed: 403,
  trigger_delivery_in_progress: 409,
  trigger_rate_limited: 429,
  trigger_concurrency_limited: 429,
  trigger_body_too_large: 413,
  trigger_prompt_too_long: 413,
  trigger_idempotency_key_invalid: 400,
  trigger_zoom_not_configured: 422,
} as const;

export type TriggerProblemCode = keyof typeof TRIGGER_PROBLEM_CODES;
