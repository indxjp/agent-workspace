import { z } from 'zod';

import { SECRET_NAME_MAX_LENGTH, SECRET_NAME_PATTERN } from './secrets.js';

/**
 * ADR-0109 slice-2 amendment, issue #564: the names the local runtime reads from its own
 * environment, so no project secret may take one. A secret named `PORT` or `PATH` would reach the
 * runtime's environment and change how it starts, so a reference to one is refused at its path.
 *
 * In order: the C1 set, `AW_DEPLOYMENT_POLICY`, the names `applyLocalRuntimeEnvironment` writes,
 * the names `applyLocalSecrets` writes, `DATABASE_URL` and the process variables. Every name
 * starting with {@link RESERVED_SECRET_NAME_PREFIX} is reserved as well; the `AW_` names stay in
 * this list so a drift test can compare against it directly. Matching ignores case
 * ({@link isReservedSecretName}). The list is frozen, so it always matches what is enforced.
 */
export const RESERVED_SECRET_NAMES = [
  'HOST',
  'AW_DEPLOYMENT_POSTURE',
  'AW_LOCAL_SURFACE_SESSIONS',
  'PORT',
  'BOOTSTRAP_ADMIN',
  'RUNTIME_DRIVER',
  'WORKSPACE_SLUG',
  'AW_DEPLOYMENT_POLICY',
  'NODE_ENV',
  'MIGRATIONS_DIR',
  'GATEWAY_PRICING_JSON',
  'AW_DEPLOYMENT_DEFAULT_MODELS',
  'AW_LOCAL_MODEL_SECRETS',
  'GATEWAY_PORT',
  'RUNNER_PORT',
  'AW_DATABASE_PORT',
  'SESSION_SECRET',
  'MASTER_ENCRYPTION_KEY',
  'GATEWAY_TOKEN_SECRET',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'DATABASE_URL',
  'PATH',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'NODE_OPTIONS',
] as const;
Object.freeze(RESERVED_SECRET_NAMES);

/** One of {@link RESERVED_SECRET_NAMES}. */
export type ReservedSecretName = (typeof RESERVED_SECRET_NAMES)[number];

/** Every name starting with this prefix, in any case, is reserved for the local runtime. */
export const RESERVED_SECRET_NAME_PREFIX = 'AW_';

const RESERVED_SECRET_NAME_SET: ReadonlySet<string> = new Set<string>(RESERVED_SECRET_NAMES);

/** An ASCII identifier: the only shape a reserved name can take, in any case. */
const ASCII_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;

/**
 * The ASCII upper-case form of `name` when it is an ASCII identifier of at most
 * {@link SECRET_NAME_MAX_LENGTH} characters, else `null`. Only ASCII is ever upper-cased, so a
 * non-ASCII case mapping (U+0131 to `I`, U+017F to `S`) cannot make a name reserved.
 */
function asciiIdentifierUpperCase(name: string): string | null {
  if (name.length > SECRET_NAME_MAX_LENGTH || !ASCII_IDENTIFIER_PATTERN.test(name)) return null;
  return name.toUpperCase();
}

/** The ASCII upper-case form of `name` when it is reserved ({@link isReservedSecretName}), else `null`. */
function reservedUpperCase(name: string): string | null {
  const upper = asciiIdentifierUpperCase(name);
  if (upper === null) return null;
  const reserved =
    RESERVED_SECRET_NAME_SET.has(upper) || upper.startsWith(RESERVED_SECRET_NAME_PREFIX);
  return reserved ? upper : null;
}

/**
 * True when `name` is reserved for the local runtime: an ASCII identifier of at most
 * {@link SECRET_NAME_MAX_LENGTH} characters whose ASCII upper-case form is in
 * {@link RESERVED_SECRET_NAMES} or starts with {@link RESERVED_SECRET_NAME_PREFIX}. Case is
 * ignored, so `path` and `Aw_X` are reserved; `AWS_KEY` is not.
 */
export function isReservedSecretName(name: string): boolean {
  return reservedUpperCase(name) !== null;
}

/**
 * A secret's name ({@link SECRET_NAME_PATTERN}, at most {@link SECRET_NAME_MAX_LENGTH}
 * characters) that is not reserved for the local runtime ({@link isReservedSecretName}). The name
 * inside a {@link SecretReferenceSchema} and each entry of the local runtime `start` message's
 * `environment.withheld` (issue #564).
 *
 * The checks run in order and each aborts: a string, the length bound, the reserved check, then
 * the grammar. The reserved check runs before the grammar, so `port` is refused as reserved rather
 * than as lower-case (ADR-0109 slice-2 amendment).
 */
export const SecretNameSchema = z
  .string({ error: 'must be a secret name' })
  .max(SECRET_NAME_MAX_LENGTH, { abort: true, error: 'must be a secret name' })
  .check((ctx) => {
    const upper = reservedUpperCase(ctx.value);
    if (upper === null) return;
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      message: `${upper} is a variable the local runtime uses; name the secret something else`,
      continue: false,
    });
  })
  .regex(SECRET_NAME_PATTERN, {
    error: 'must be a secret name: A-Z first, then A-Z, 0-9 or _, at most 128 characters',
  });

/**
 * Issue #524 (S2-01a), C10, ADR-0102 SD6: a reference to a secret by its **name**, never its value.
 *
 * The YAML `{ secret: NAME }` of a project file and the TypeScript `secret('NAME')` are this one
 * strict object. `NAME` is a {@link SecretNameSchema}: a secret's name ({@link SECRET_NAME_PATTERN},
 * at most {@link SECRET_NAME_MAX_LENGTH} characters), the same grammar `POST /api/secrets` stores,
 * and not a name the local runtime reserves ({@link RESERVED_SECRET_NAMES}, refused at the
 * reference's `secret` path; issue #564). On `local`, `aw` reads the value from its own
 * environment and sends it only in a create or rotate request; the value never appears in a
 * project file.
 *
 * A string where a reference belongs (a pasted `sk-…` key) is refused at the reference's own path.
 * No message here echoes the input, with one bounded exception: the object's error is fixed text,
 * the length check aborts before anything else runs, and the pattern's message names the grammar
 * only. The exception is a reserved name, which the message names in its ASCII upper-case form;
 * only an ASCII identifier of at most 128 characters that the reserved list or the `AW_` prefix
 * matched is ever named (ADR-0109 slice-2 amendment, issue #564). A caller that reports a refusal
 * can therefore print every issue message without leaking a credential.
 */
export const SecretReferenceSchema = z
  .object(
    { secret: SecretNameSchema },
    { error: 'must be a secret reference { secret: NAME }, never the value' },
  )
  .strict()
  .readonly();

/** A parsed {@link SecretReferenceSchema}: `{ secret: NAME }` (C10, issue #524). */
export type SecretReference = z.infer<typeof SecretReferenceSchema>;
