import { z } from 'zod';

import { PLATFORM_IDS } from './platform-ids.js';
import { SecretReferenceSchema } from './secret-reference.js';
import { urlCarriesCredential } from './url-credential.js';

/**
 * Keys whose value is a credential: they must hold a secret reference, never a value (C10). Matched
 * on the key's end, case-insensitively, so `clientSecret`, `accessToken` and `apiKey` match and
 * `tokenUrl` does not.
 */
const SECRET_KEY_PATTERN =
  /(?:secret|token|password|passwd|apikey|api[-_]key|credentials?|privatekey|private[-_]key|connectionstring|connection[-_]string)$/iu;

/** The longest option key a platform binding may name, in characters. */
const OPTION_KEY_MAX_LENGTH = 128;

/** The reserved key a record would drop rather than check (see `refuseUnsafeOptions`). */
const PROTOTYPE_KEY = '__proto__';

/** The fixed refusal for a credential in a URL; it never echoes the value (as in `project-file.ts`). */
const URL_CREDENTIAL_MESSAGE =
  'must not carry a credential; name it as a secret reference { secret: NAME } (C10)';

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Walks a raw options value (arrays by index, objects by own keys) and adds an issue, at its full
 * path, for what no platform may accept: an own `__proto__` key, a credential-named key that does
 * not hold a `{ secret: NAME }` reference, and a URL string that carries a credential. It never
 * descends into a credential-named key and no message echoes a value.
 */
function walkOptions(
  value: unknown,
  path: readonly (string | number)[],
  context: z.RefinementCtx<unknown>,
): void {
  if (typeof value === 'string') {
    if (URL.canParse(value) && urlCarriesCredential(new URL(value))) {
      context.addIssue({ code: 'custom', path: [...path], message: URL_CREDENTIAL_MESSAGE });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => {
      walkOptions(item, [...path, index], context);
    });
    return;
  }
  if (!isRecordLike(value)) return;
  for (const key of Object.keys(value)) {
    const child = value[key];
    const childPath = [...path, key];
    if (key === PROTOTYPE_KEY) {
      context.addIssue({ code: 'custom', path: childPath, message: 'is a reserved key' });
    } else if (SECRET_KEY_PATTERN.test(key)) {
      refuseSecretValue(child, childPath, context);
    } else {
      walkOptions(child, childPath, context);
    }
  }
}

function refuseSecretValue(
  value: unknown,
  path: readonly (string | number)[],
  context: z.RefinementCtx<unknown>,
): void {
  if (isRecordLike(value) && Object.hasOwn(value, 'secret')) {
    const reference = SecretReferenceSchema.safeParse(value);
    if (!reference.success) {
      for (const issue of reference.error.issues) {
        context.addIssue({
          code: 'custom',
          path: [...path, ...issue.path.filter((part) => typeof part !== 'symbol')],
          message: issue.message,
        });
      }
    }
    return;
  }
  context.addIssue({
    code: 'custom',
    path: [...path],
    message: 'must be a secret reference { secret: NAME }, never a value (C10)',
  });
}

function refuseUnsafeOptions(value: unknown, context: z.RefinementCtx<unknown>): void {
  if (isRecordLike(value) && !Array.isArray(value)) walkOptions(value, [], context);
}

/**
 * Opaque per-platform options: each platform's `optionsSchema` validates them at export time. Here
 * only what no platform may accept is refused, on the raw input (before the record drops an own
 * `__proto__`): an own `__proto__` key anywhere, a credential-named key whose value is not a
 * `{ secret: NAME }` reference, and a URL string carrying a credential.
 */
export const PlatformOptionsSchema = z
  .unknown()
  .superRefine(refuseUnsafeOptions)
  .pipe(z.record(z.string().min(1).max(OPTION_KEY_MAX_LENGTH), z.unknown()).readonly());
export type PlatformOptions = z.infer<typeof PlatformOptionsSchema>;

/** One platform's entry under `platforms:` in a v2 project file (brief D7, ADR-0133). */
export const ProjectPlatformBindingSchema = z
  .strictObject({
    enabled: z.boolean({ error: 'is required: true or false' }),
    options: PlatformOptionsSchema.optional(),
    /** Overrides merged over `options`, shallowly, by `aw platforms … --env <name>`. */
    environments: z
      .strictObject({
        local: PlatformOptionsSchema.optional(),
        production: PlatformOptionsSchema.optional(),
      })
      .readonly()
      .optional(),
  })
  .readonly();
export type ProjectPlatformBinding = z.infer<typeof ProjectPlatformBindingSchema>;

/** `platforms:` — one optional binding per platform id; any other key is refused at its own path. */
export const ProjectPlatformsSchema = z
  .strictObject(
    {
      'claude-managed-agents': ProjectPlatformBindingSchema.optional(),
      'copilot-studio': ProjectPlatformBindingSchema.optional(),
      'm365-declarative-agent': ProjectPlatformBindingSchema.optional(),
      'microsoft-foundry': ProjectPlatformBindingSchema.optional(),
      'gemini-enterprise': ProjectPlatformBindingSchema.optional(),
      'aws-agentcore': ProjectPlatformBindingSchema.optional(),
      'eject-claude-agent-sdk': ProjectPlatformBindingSchema.optional(),
      'eject-mastra': ProjectPlatformBindingSchema.optional(),
      'eject-openai-agents': ProjectPlatformBindingSchema.optional(),
    },
    {
      error: (issue) =>
        issue.code === 'unrecognized_keys'
          ? `is not a platform; use one of ${PLATFORM_IDS.join(', ')}`
          : undefined,
    },
  )
  .readonly();
export type ProjectPlatforms = z.infer<typeof ProjectPlatformsSchema>;
