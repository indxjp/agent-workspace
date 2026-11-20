import { and, eq, type SQL } from 'drizzle-orm';

import {
  runtimeProfiles,
  type NewRuntimeProfileRow,
  type RuntimeProfileDriver,
  type RuntimeProfileFilesystem,
  type RuntimeProfileNetworkPolicy,
} from '../schema/runtime-profiles.js';
import type {
  CreateRuntimeProfileInput,
  RuntimeProfileRecord,
  UpdateRuntimeProfilePatch,
} from './runtime-profiles-types.js';
import { postgresViolations } from './violations.js';

/** Transcribed from `migrations/`, which is the artefact PostgreSQL actually reports. */
const NAME_CONFLICT_CONSTRAINTS: ReadonlySet<string> = new Set([
  'runtime_profiles_workspace_name_key',
]);
const RUNTIME_CONNECTION_CONSTRAINTS: ReadonlySet<string> = new Set([
  'runtime_profiles_runtime_connection_id_secrets_id_fk',
  'runtime_profiles_runtime_connection_workspace_fk',
]);

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

export function classifyWriteFailure(
  error: unknown,
): 'name-conflict' | 'unknown-runtime-connection' | null {
  for (const failure of postgresViolations(error)) {
    if (failure.code === UNIQUE_VIOLATION && NAME_CONFLICT_CONSTRAINTS.has(failure.constraint)) {
      return 'name-conflict';
    }
    if (
      failure.code === FOREIGN_KEY_VIOLATION &&
      RUNTIME_CONNECTION_CONSTRAINTS.has(failure.constraint)
    ) {
      return 'unknown-runtime-connection';
    }
  }
  return null;
}

export const RUNTIME_PROFILE_COLUMNS = {
  id: runtimeProfiles.id,
  workspaceId: runtimeProfiles.workspaceId,
  name: runtimeProfiles.name,
  driver: runtimeProfiles.driver,
  runtimeConnectionId: runtimeProfiles.runtimeConnectionId,
  cpu: runtimeProfiles.cpu,
  memoryMb: runtimeProfiles.memoryMb,
  diskMb: runtimeProfiles.diskMb,
  networkPolicy: runtimeProfiles.networkPolicy,
  allowedDomains: runtimeProfiles.allowedDomains,
  filesystem: runtimeProfiles.filesystem,
  persistPaths: runtimeProfiles.persistPaths,
  timeoutSeconds: runtimeProfiles.timeoutSeconds,
  idleTimeoutSeconds: runtimeProfiles.idleTimeoutSeconds,
  driverConfig: runtimeProfiles.driverConfig,
  createdAt: runtimeProfiles.createdAt,
  updatedAt: runtimeProfiles.updatedAt,
} as const;

type SelectedRow = {
  id: string;
  workspaceId: string;
  name: string;
  driver: string;
  runtimeConnectionId: string | null;
  cpu: number | null;
  memoryMb: number | null;
  diskMb: number | null;
  networkPolicy: string;
  allowedDomains: unknown;
  filesystem: string;
  persistPaths: unknown;
  timeoutSeconds: number | null;
  idleTimeoutSeconds: number | null;
  driverConfig: unknown;
  createdAt: Date;
  updatedAt: Date;
};

/** A jsonb array-or-null column, read as `readonly string[] | null` without trusting the type. */
function toStringArrayOrNull(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return value;
  }
  throw new Error('a runtime_profiles jsonb array column did not hold an array of strings');
}

function toRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error('runtime_profiles.driver_config did not hold a JSON object');
}

export function toRecord(row: SelectedRow): RuntimeProfileRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    driver: row.driver as RuntimeProfileDriver,
    runtimeConnectionId: row.runtimeConnectionId,
    cpu: row.cpu,
    memoryMb: row.memoryMb,
    diskMb: row.diskMb,
    networkPolicy: row.networkPolicy as RuntimeProfileNetworkPolicy,
    allowedDomains: toStringArrayOrNull(row.allowedDomains),
    filesystem: row.filesystem as RuntimeProfileFilesystem,
    persistPaths: toStringArrayOrNull(row.persistPaths),
    timeoutSeconds: row.timeoutSeconds,
    idleTimeoutSeconds: row.idleTimeoutSeconds,
    driverConfig: toRecordOrNull(row.driverConfig),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The insert values for `input` in `workspaceId`; shared by `create` and `ensureWorkspaceDefault`. */
export function insertValues(
  workspaceId: string,
  input: CreateRuntimeProfileInput,
): NewRuntimeProfileRow {
  return {
    workspaceId,
    name: input.name,
    driver: input.driver,
    runtimeConnectionId: input.runtimeConnectionId,
    cpu: input.cpu,
    memoryMb: input.memoryMb,
    diskMb: input.diskMb,
    networkPolicy: input.networkPolicy,
    allowedDomains: input.allowedDomains ? [...input.allowedDomains] : null,
    filesystem: input.filesystem,
    persistPaths: input.persistPaths ? [...input.persistPaths] : null,
    timeoutSeconds: input.timeoutSeconds,
    idleTimeoutSeconds: input.idleTimeoutSeconds,
    driverConfig: input.driverConfig ? { ...input.driverConfig } : null,
  };
}

/** Scalar patch keys copied as-is; the three below are copied defensively. */
const SCALAR_PATCH_KEYS = [
  'name',
  'driver',
  'runtimeConnectionId',
  'cpu',
  'memoryMb',
  'diskMb',
  'networkPolicy',
  'filesystem',
  'timeoutSeconds',
  'idleTimeoutSeconds',
] as const;

/** The columns a patch changes: an absent key is left alone, `null` clears. */
export function patchChanges(patch: UpdateRuntimeProfilePatch): Record<string, unknown> {
  const changes: Record<string, unknown> = {};
  for (const key of SCALAR_PATCH_KEYS) {
    if (patch[key] !== undefined) changes[key] = patch[key];
  }
  if (patch.allowedDomains !== undefined) {
    changes['allowedDomains'] = patch.allowedDomains ? [...patch.allowedDomains] : null;
  }
  if (patch.persistPaths !== undefined) {
    changes['persistPaths'] = patch.persistPaths ? [...patch.persistPaths] : null;
  }
  if (patch.driverConfig !== undefined) {
    changes['driverConfig'] = patch.driverConfig ? { ...patch.driverConfig } : null;
  }
  return changes;
}

/** `tenant` matches every row of the workspace; `within` narrows it by one more predicate. */
export function workspacePredicates(workspaceId: string): {
  readonly tenant: SQL;
  readonly within: (rest: SQL) => SQL;
} {
  const tenant = eq(runtimeProfiles.workspaceId, workspaceId);
  const within = (rest: SQL): SQL => {
    const combined = and(tenant, rest);
    if (combined === undefined) throw new Error('the workspace predicate could not be built');
    return combined;
  };
  return { tenant, within };
}
