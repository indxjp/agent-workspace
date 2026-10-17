import { z } from 'zod';

import { IsoDateTimeSchema } from './identifiers.js';

/**
 * The runtime drivers a profile or connection can name — the control plane's catalogue, in the
 * order the specification lists them. `runtime_profiles.driver` carries the same list as a
 * database `CHECK`, so a value outside it can never be stored.
 */
export const RUNTIME_DRIVERS = [
  'local',
  'sandbox-runtime',
  'docker',
  'kubernetes',
  'gke-agent-sandbox',
  'aca-sessions',
  'aws-agentcore',
  'aws-ecs',
  'cloud-run-sandbox',
  'cloud-run-service',
  'external',
  'vercel-sandbox',
  'cloudflare-sandbox',
] as const;
export type RuntimeDriver = (typeof RUNTIME_DRIVERS)[number];

/**
 * The sandbox providers the `external` driver reaches. A deployment profile names one as
 * `runtime.provider` and a runtime profile as `driverConfig.provider`; absent means `e2b`, which is
 * what `external` has always meant. Anything else is refused at validation, not at the first run.
 */
export const EXTERNAL_RUNTIME_PROVIDERS = ['e2b'] as const;
export type ExternalRuntimeProvider = (typeof EXTERNAL_RUNTIME_PROVIDERS)[number];

/**
 * What a runtime may reach over the network: nothing, the gateway plus `allowedDomains`, or
 * everything. The server is authoritative about which of these a driver can enforce in a given
 * deployment and refuses the rest with `network_policy_not_enforceable`.
 */
export const RUNTIME_NETWORK_POLICIES = ['none', 'restricted', 'open'] as const;
export type RuntimeNetworkPolicy = (typeof RUNTIME_NETWORK_POLICIES)[number];

/** Whether the runtime's working tree may be written to; `persistPaths` survive either way. */
export const RUNTIME_FILESYSTEM_MODES = ['read-only', 'read-write'] as const;
export type RuntimeFilesystemMode = (typeof RUNTIME_FILESYSTEM_MODES)[number];

/**
 * The bounds `POST`/`PATCH /api/runtime-profiles` enforce on the sizing fields. `cpu` is a count
 * of cores and may be fractional (`0.5`); every other field is a whole number of megabytes or
 * seconds. The upper bound is the largest integer JavaScript represents exactly — the server
 * imposes no smaller ceiling.
 */
export const RUNTIME_PROFILE_BOUNDS = {
  /** Greater than zero, finite; fractions are allowed. */
  cpu: { exclusiveMin: 0 },
  memoryMb: { min: 1, max: Number.MAX_SAFE_INTEGER },
  diskMb: { min: 1, max: Number.MAX_SAFE_INTEGER },
  timeoutSeconds: { min: 1, max: Number.MAX_SAFE_INTEGER },
  idleTimeoutSeconds: { min: 1, max: Number.MAX_SAFE_INTEGER },
} as const;

const PositiveIntegerSchema = z
  .number()
  .int()
  .min(RUNTIME_PROFILE_BOUNDS.memoryMb.min)
  .max(RUNTIME_PROFILE_BOUNDS.memoryMb.max);

/**
 * One runtime profile as `GET /api/runtime-profiles/:id`, the `201` of `POST /api/runtime-profiles`,
 * the `200` of `PATCH /api/runtime-profiles/:id` and every list item render it — a **bare** item,
 * never wrapped. A sizing field is `null` when the profile leaves it to the driver's default.
 * `driverConfig` is the per-driver escape hatch, validated as an object. On create and update the
 * control plane also refuses a key that names a credential (credentials belong on a runtime
 * connection, ADR-0088); the rule applies on write only, so a row stored before it still reads.
 */
export const RuntimeProfileResourceSchema = z
  .object({
    id: z.string().min(1),
    workspaceId: z.string().min(1),
    name: z.string().min(1),
    driver: z.enum(RUNTIME_DRIVERS),
    /** The stored runtime connection (cluster, pool, image registry…) the driver uses, if any. */
    runtimeConnectionId: z.string().min(1).nullable(),
    cpu: z.number().gt(RUNTIME_PROFILE_BOUNDS.cpu.exclusiveMin).nullable(),
    memoryMb: PositiveIntegerSchema.nullable(),
    diskMb: PositiveIntegerSchema.nullable(),
    networkPolicy: z.enum(RUNTIME_NETWORK_POLICIES),
    allowedDomains: z.array(z.string().min(1)).readonly().nullable(),
    filesystem: z.enum(RUNTIME_FILESYSTEM_MODES),
    persistPaths: z.array(z.string().min(1)).readonly().nullable(),
    timeoutSeconds: PositiveIntegerSchema.nullable(),
    idleTimeoutSeconds: PositiveIntegerSchema.nullable(),
    driverConfig: z.record(z.string(), z.unknown()).readonly().nullable(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

export type RuntimeProfileResource = z.infer<typeof RuntimeProfileResourceSchema>;

/** The body of `GET /api/runtime-profiles`: the caller's workspace's profiles, oldest first. */
export const RuntimeProfileListResponseSchema = z
  .object({ runtimeProfiles: z.array(RuntimeProfileResourceSchema).readonly() })
  .strict()
  .readonly();

export type RuntimeProfileListResponse = z.infer<typeof RuntimeProfileListResponseSchema>;

/**
 * The body of `POST /api/runtime-profiles`. An omitted sizing field is stored as `null` and left
 * to the driver. `driverConfig.image`, when present, must pin an image by `sha256` digest, and a
 * `driverConfig` key whose words name a credential (`password`, `secret`, `token`, `apiKey`…), at
 * any depth, is refused with `400 invalid_body`: put the credential on a runtime connection.
 */
export interface CreateRuntimeProfileInput {
  readonly name: string;
  readonly driver: RuntimeDriver;
  readonly runtimeConnectionId?: string;
  readonly cpu?: number;
  readonly memoryMb?: number;
  readonly diskMb?: number;
  readonly networkPolicy: RuntimeNetworkPolicy;
  /** `null`, as a profile reads back, means none. */
  readonly allowedDomains?: readonly string[] | null;
  readonly filesystem: RuntimeFilesystemMode;
  readonly persistPaths?: readonly string[];
  readonly timeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly driverConfig?: Readonly<Record<string, unknown>>;
}

/**
 * The body of `PATCH /api/runtime-profiles/:id`; an omitted field remains unchanged. The route
 * does not accept `null`, so a sizing field that was once set cannot be cleared by a patch.
 */
export interface UpdateRuntimeProfilePatch {
  readonly name?: string;
  readonly driver?: RuntimeDriver;
  readonly runtimeConnectionId?: string;
  readonly cpu?: number;
  readonly memoryMb?: number;
  readonly diskMb?: number;
  readonly networkPolicy?: RuntimeNetworkPolicy;
  /** `null`, as a profile reads back, means none. */
  readonly allowedDomains?: readonly string[] | null;
  readonly filesystem?: RuntimeFilesystemMode;
  readonly persistPaths?: readonly string[];
  readonly timeoutSeconds?: number;
  readonly idleTimeoutSeconds?: number;
  readonly driverConfig?: Readonly<Record<string, unknown>>;
}

/**
 * One runtime connection as the `201` of `POST /api/runtime-connections` and every item of
 * `GET /api/runtime-connections` render it — a **bare** item. The endpoint and the credential are
 * write-only: they are sealed at creation and never appear in a response. `name` is the stored
 * form — upper-cased, with every other character folded to `_` — not the caller's display text.
 */
export const RuntimeConnectionResourceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    driver: z.enum(RUNTIME_DRIVERS),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .readonly();

export type RuntimeConnectionResource = z.infer<typeof RuntimeConnectionResourceSchema>;

/** The body of `GET /api/runtime-connections`. */
export const RuntimeConnectionListResponseSchema = z
  .object({ runtimeConnections: z.array(RuntimeConnectionResourceSchema).readonly() })
  .strict()
  .readonly();

export type RuntimeConnectionListResponse = z.infer<typeof RuntimeConnectionListResponseSchema>;

/**
 * The body of `POST /api/runtime-connections`. Every field is a non-empty string; `endpoint` and
 * `credential` are stored sealed and cannot be read back.
 */
export interface CreateRuntimeConnectionInput {
  readonly name: string;
  readonly driver: RuntimeDriver;
  readonly endpoint: string;
  readonly credential: string;
}
