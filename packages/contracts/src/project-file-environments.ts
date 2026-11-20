import { z } from 'zod';

import type { RuntimeDriver } from './runtimes.js';

/** The clouds an environment may target; `local` is the developer's own machine. */
export const PROJECT_CLOUDS = ['aws', 'gcp', 'azure', 'local'] as const;
export type ProjectCloud = (typeof PROJECT_CLOUDS)[number];

/** The port `aw dev` serves the local environment on when the file names none (ADR-0109). */
export const DEFAULT_LOCAL_PORT = 3000;

/**
 * The port the local runtime's model gateway binds before web (ADR-0109: fixed, unlike
 * `environments.local.port`). Issue #560: a project port equal to it can never start.
 */
export const LOCAL_RUNTIME_GATEWAY_PORT = 4000;

/**
 * The port the local runtime's runner binds before web (ADR-0109: fixed, unlike
 * `environments.local.port`). Issue #560: a project port equal to it can never start.
 */
export const LOCAL_RUNTIME_RUNNER_PORT = 8080;

/**
 * The ports the local runtime keeps for its own services (ADR-0109), with the service each one
 * belongs to, so a refusal can name it. `environments.local.port` may be none of them.
 */
export const LOCAL_RUNTIME_RESERVED_PORTS = [
  { port: LOCAL_RUNTIME_GATEWAY_PORT, service: 'gateway' },
  { port: LOCAL_RUNTIME_RUNNER_PORT, service: 'runner' },
] as const;
export type LocalRuntimeReservedPort = (typeof LOCAL_RUNTIME_RESERVED_PORTS)[number];
export type LocalRuntimeService = LocalRuntimeReservedPort['service'];

/** The bootstrap Owner `aw init` writes for the local environment (ADR-0103, ADR-0109). */
export const DEFAULT_BOOTSTRAP_ADMIN = 'admin@localhost.test';

/** The email shape the CLI's profile has always accepted for the bootstrap Owner. */
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/u;

/** The longest bootstrap Owner address, in characters (RFC 5321's path limit, rounded up). */
export const BOOTSTRAP_ADMIN_MAX_LENGTH = 320;

/**
 * No C0 control, DEL or C1 control (U+0000–U+001F, U+007F, U+0080–U+009F): `\p{Cc}` is exactly
 * that set.
 */
const NO_CONTROL_CHARACTER_PATTERN = /^\P{Cc}*$/u;

/**
 * The bootstrap Owner's email: the one schema the project file and the local runtime's `start`
 * message share, so a project file that validates always fits a `start` message. The length check
 * aborts before the pattern runs, so an over-long value is refused without backtracking over it.
 * A value holding a C0 control, DEL or a C1 control (U+0000–U+001F, U+007F, U+0080–U+009F) is
 * refused before the email pattern runs, because a client prints this address and such a character
 * can rewrite what a terminal shows — so no client has to re-check it.
 */
export const BootstrapAdminSchema = z
  .string()
  .max(BOOTSTRAP_ADMIN_MAX_LENGTH, { abort: true })
  .regex(NO_CONTROL_CHARACTER_PATTERN, {
    message: 'must not contain a control character',
    abort: true,
  })
  .regex(EMAIL_PATTERN, 'must be an email address');

/**
 * The runtime drivers `packages/runtime` implements — the ones a project file or a `start` message
 * may name. The other ids of {@link RuntimeDriver} are catalogued but unbuilt, so naming one would
 * validate here and fail only when the runtime tried to register it; the CLI's profile schema
 * refuses the same ids. A driver joins this list in the change that implements it.
 */
export const IMPLEMENTED_RUNTIME_DRIVERS = [
  'local',
  'sandbox-runtime',
  'docker',
  'kubernetes',
  'cloud-run-service',
  'aca-sessions',
] as const satisfies readonly RuntimeDriver[];
export type ImplementedRuntimeDriver = (typeof IMPLEMENTED_RUNTIME_DRIVERS)[number];

/**
 * Where an environment keeps its data. Structural only: which managed store, object scheme and
 * secret backend a cloud may name stays in the CLI until P-2.
 */
export const ProjectStorageSchema = z
  .object({
    relational: z.string().min(1).max(1024),
    objects: z.string().min(1).max(1024),
    secrets: z.string().min(1).max(1024),
  })
  .strict()
  .readonly();
export type ProjectStorage = z.infer<typeof ProjectStorageSchema>;

/** The runtime driver an environment's agents run on unless an agent says otherwise. */
export const ProjectRuntimeSchema = z
  .object({ default: z.enum(IMPLEMENTED_RUNTIME_DRIVERS) })
  .strict()
  .readonly();
export type ProjectRuntime = z.infer<typeof ProjectRuntimeSchema>;

/** Who may first sign in: the bootstrap Owner's email and, optionally, an https OIDC issuer. */
export const ProjectIdentitySchema = z
  .object({
    bootstrapAdmin: BootstrapAdminSchema,
    oidc: z
      .url({ protocol: /^https$/u, error: 'must be an https:// issuer URL' })
      .max(2048)
      .optional(),
  })
  .strict()
  .readonly();
export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;

/** A TCP port the environment serves on. */
export const ProjectPortSchema = z.number().int().min(1).max(65535);

/**
 * The port the `local` environment serves web on: a {@link ProjectPortSchema} that is not one of
 * {@link LOCAL_RUNTIME_RESERVED_PORTS} (ADR-0109, issue #560). A reserved port gets one issue
 * naming the service, which a reader prefixes with the field's path. The project file is shared, so
 * this follows the fixed ADR-0109 ports whatever a machine's `.env` moves the runner or gateway to;
 * the local runtime refuses the ports it will really bind, the embedded PostgreSQL's included,
 * again before it starts.
 */
export const LocalPortSchema = ProjectPortSchema.superRefine((port, context) => {
  const reserved = LOCAL_RUNTIME_RESERVED_PORTS.find((entry) => entry.port === port);
  if (reserved !== undefined) {
    context.addIssue({
      code: 'custom',
      message: `is reserved by the local runtime's ${reserved.service} (${String(reserved.port)}); choose another port`,
    });
  }
});

/** One environment of a project, any cloud: the general shape slice 2 onwards builds on. */
export const ProjectEnvironmentSchema = z
  .object({
    cloud: z.enum(PROJECT_CLOUDS),
    storage: ProjectStorageSchema.optional(),
    runtime: ProjectRuntimeSchema.optional(),
    identity: ProjectIdentitySchema,
    port: ProjectPortSchema.optional(),
  })
  .strict()
  .readonly();
export type ProjectEnvironment = z.infer<typeof ProjectEnvironmentSchema>;

/**
 * Slice 1's `local` environment: `cloud: local`, and no `storage` key at all — `aw dev` provides
 * the stores itself (ADR-0109), so a `storage` block here is refused rather than ignored.
 *
 * A per-environment `policy` is not built yet (ADR-0102 SD6, issue #524): it is refused at
 * `environments.local.policy`, and the top-level `policy` is the one ceiling.
 */
export const LocalEnvironmentSchema = z
  .object({
    cloud: z.literal('local'),
    runtime: ProjectRuntimeSchema.optional(),
    identity: ProjectIdentitySchema,
    port: LocalPortSchema.optional(),
    policy: z
      .never({
        error: 'a per-environment policy is not built yet; use the top-level policy (ADR-0102 SD6)',
      })
      .optional(),
  })
  .strict()
  .readonly();
export type LocalEnvironment = z.infer<typeof LocalEnvironmentSchema>;
