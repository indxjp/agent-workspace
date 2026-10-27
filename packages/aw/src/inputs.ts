/**
 * The bodies `--file <json>` / `-` may carry, as schemas.
 *
 * The contracts publish request bodies as TypeScript interfaces (the server's parsers own the
 * per-field messages), so the CLI needs its own runtime check before it sends anything. Each
 * schema here is written to the interface it feeds, and the proof is at the call site: the
 * parsed value is passed to the SDK method typed with that interface, so a schema that admits
 * something the contract does not fails to compile. `.strict()` refuses keys the route would
 * refuse anyway, with a clearer message and before a request is made.
 */
import { z } from 'zod';

import {
  AgentDefinitionSchema,
  AgentPermissionsSchema,
  AgentGrantsSchema,
  AgentPolicySchema,
  AgentResourceAssignmentsSchema,
} from '@indx-workspace/contracts/agents';
import {
  CONNECTOR_AUTH_TYPES,
  REMOTE_CONNECTOR_TRANSPORTS,
} from '@indx-workspace/contracts/connectors';
import { MODEL_PROVIDERS } from '@indx-workspace/contracts/runs';
import {
  RUNTIME_DRIVERS,
  RUNTIME_FILESYSTEM_MODES,
  RUNTIME_NETWORK_POLICIES,
} from '@indx-workspace/contracts/runtimes';
import { SkillFileSchema } from '@indx-workspace/contracts/skills';
import { PROJECT_VISIBILITIES } from '@indx-workspace/contracts/projects';
import { MEMBERSHIP_ROLES } from '@indx-workspace/contracts/team';

/**
 * A parsed JSON body never holds `undefined` — JSON has no such value — but `z.optional()`
 * types an absent key as `T | undefined`, which `exactOptionalPropertyTypes` rightly refuses to
 * pass to an interface whose optional keys are exact. This is the type of a value with every
 * `undefined` removed, which {@link exact} produces.
 */
export type Exact<T> = T extends readonly (infer Item)[]
  ? readonly Exact<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: Exact<Exclude<T[Key], undefined>> }
    : T;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutUndefined);
  if (!isRecord(value)) return value;
  const entries = Object.entries(value)
    .filter(([, field]) => field !== undefined)
    .map(([key, field]) => [key, withoutUndefined(field)] as const);
  return Object.fromEntries(entries);
}

/**
 * Parse `value` with `schema` and drop every `undefined` (there is none in JSON, so this changes
 * the type, not the data). The assertion is the one place the CLI narrows a type by hand, and it
 * is narrow: the value is the schema's own output with a documented, mechanical transformation.
 */
export function exact<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): Exact<z.output<Schema>> {
  const parsed: z.output<Schema> = schema.parse(value);
  return withoutUndefined(parsed) as Exact<z.output<Schema>>;
}

const Role = z.enum(MEMBERSHIP_ROLES);
const nullableString = z.string().nullable();

/** `members add`. */
export const EmailRoleBody = z.object({ email: z.string(), role: Role }).strict();
export const CreateWorkspaceBody = z.object({ name: z.string(), slug: z.string() }).strict();
export const UpdateWorkspaceBody = z
  .object({ name: z.string().optional(), archived: z.boolean().optional() })
  .strict();
export const CreateUserBody = z
  .object({ email: z.string(), name: z.string(), role: Role })
  .strict();
export const CreateApiKeyBody = z
  .object({ name: z.string(), role: Role, expiresAt: nullableString.optional() })
  .strict();

const ModelConnectionConfig = z
  .object({
    baseUrl: z.string().optional(),
    deployment: z.string().optional(),
    apiVersion: z.string().optional(),
  })
  .strict();
export const CreateModelConnectionBody = z
  .object({
    name: z.string(),
    provider: z.enum(MODEL_PROVIDERS),
    apiKey: z.string(),
    config: ModelConnectionConfig.optional(),
  })
  .strict();
export const UpdateModelConnectionBody = z
  .object({
    name: z.string().optional(),
    config: ModelConnectionConfig.optional(),
    apiKey: z.string().optional(),
  })
  .strict();

const runtimeProfileFields = {
  name: z.string(),
  driver: z.enum(RUNTIME_DRIVERS),
  runtimeConnectionId: z.string().optional(),
  cpu: z.number().optional(),
  memoryMb: z.number().optional(),
  diskMb: z.number().optional(),
  networkPolicy: z.enum(RUNTIME_NETWORK_POLICIES),
  allowedDomains: z.array(z.string()).nullable().optional(),
  filesystem: z.enum(RUNTIME_FILESYSTEM_MODES),
  persistPaths: z.array(z.string()).optional(),
  timeoutSeconds: z.number().optional(),
  idleTimeoutSeconds: z.number().optional(),
  driverConfig: z.record(z.string(), z.unknown()).optional(),
};
export const CreateRuntimeProfileBody = z.object(runtimeProfileFields).strict();
export const UpdateRuntimeProfileBody = z.object(runtimeProfileFields).partial().strict();
export const CreateRuntimeConnectionBody = z
  .object({
    name: z.string(),
    driver: z.enum(RUNTIME_DRIVERS),
    endpoint: z.string(),
    credential: z.string(),
  })
  .strict();

export const CreateSecretBody = z.object({ name: z.string(), value: z.string() }).strict();

export const UpdateSkillBody = z
  .object({
    enabled: z.boolean().optional(),
    files: z.array(SkillFileSchema).optional(),
    removeFiles: z.array(z.string()).optional(),
  })
  .strict();

const connectorCredentialFields = {
  name: z.string(),
  authType: z.enum(CONNECTOR_AUTH_TYPES).optional(),
  credential: z.string().optional(),
};
export const CreateConnectorBody = z.discriminatedUnion('transport', [
  z
    .object({
      ...connectorCredentialFields,
      transport: z.literal('stdio'),
      command: z.string(),
      args: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      ...connectorCredentialFields,
      transport: z.enum(REMOTE_CONNECTOR_TRANSPORTS),
      url: z.string(),
    })
    .strict(),
]);

export const CreateAgentBody = z
  .object({
    name: z.string(),
    instructions: z.string(),
    modelConnectionId: nullableString,
    model: nullableString,
    runtimeProfileId: nullableString.optional(),
    permissions: AgentPermissionsSchema,
  })
  .strict();
export const UpdateAgentBody = z
  .object({
    name: z.string().optional(),
    instructions: z.string().optional(),
    modelConnectionId: nullableString.optional(),
    model: nullableString.optional(),
    runtimeProfileId: nullableString.optional(),
    permissions: AgentPermissionsSchema.optional(),
  })
  .strict();
export const AgentAssignmentsBody = AgentResourceAssignmentsSchema;
export const AgentGrantsBody = AgentGrantsSchema;
export const AgentPolicyBody = AgentPolicySchema;
/** `agents import` (K-1): the portable definition `agents export` writes. */
export const AgentDefinitionBody = AgentDefinitionSchema;

export const CreateProjectBody = z
  .object({
    name: z.string(),
    instructions: z.string().optional(),
    defaultAgentId: nullableString.optional(),
    visibility: z.enum(PROJECT_VISIBILITIES),
    fileIds: z.array(z.string()),
    mcpServerIds: z.array(z.string()),
  })
  .strict();
export const UpdateProjectBody = z
  .object({
    name: z.string().optional(),
    instructions: nullableString.optional(),
    defaultAgentId: nullableString.optional(),
    defaultModelConnectionId: nullableString.optional(),
    defaultModel: nullableString.optional(),
    visibility: z.enum(PROJECT_VISIBILITIES).optional(),
    fileIds: z.array(z.string()).optional(),
    mcpServerIds: z.array(z.string()).optional(),
  })
  .strict();
