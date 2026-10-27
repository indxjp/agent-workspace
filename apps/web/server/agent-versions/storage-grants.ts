/**
 * Pipeline step 4a: a `storage://<connection>/<folder>` file grant names a folder of one of the
 * deploying workspace's storage connections (the storage design, §05 and §06 Phase 5). The grant
 * is refused unless the connection exists in this workspace, the folder sits under one of its
 * `allowedPrefixes`, and a `read-write` grant finds the connection `writeAllowed`.
 */
import type { StorageGrantRef } from './store';
import {
  parseStorageGrantPath,
  STORAGE_GRANT_SCHEME,
} from '@indx-workspace/contracts/storage-connections';
import { AGENT_VERSION_PROBLEM_CODES } from '@indx-workspace/contracts/agent-versions';

import { DomainError } from '../errors';
import { problem, type ApiResult } from '../http/result';

export interface StorageGrantTarget {
  readonly id: string;
  readonly allowedPrefixes: readonly string[];
  readonly writeAllowed: boolean;
}

/** The connections of one workspace, by name; a name it does not hold is absent from the map. */
export type StorageConnectionLookup = (
  names: readonly string[],
) => Promise<ReadonlyMap<string, StorageGrantTarget>>;

/**
 * A lookup over `source`, which must already be scoped to the deploying workspace (a core
 * `StorageConnectionRepository`, or the web store's workspace store): that scope is what keeps
 * another workspace's connection of the same name out of reach.
 */
// ponytail: lists every connection of the workspace (and, through the web store, its secret names for `hasCredential`); add a by-name repository query if that grows or the secrets call matters.
export function storageConnectionLookup(source: {
  list(): Promise<readonly (StorageGrantTarget & { readonly name: string })[]>;
}): StorageConnectionLookup {
  return async (names) => {
    const wanted = new Set(names);
    const found = new Map<string, StorageGrantTarget>();
    for (const connection of await source.list()) {
      if (!wanted.has(connection.name)) continue;
      const { id, allowedPrefixes, writeAllowed } = connection;
      found.set(connection.name, { id, allowedPrefixes, writeAllowed });
    }
    return found;
  };
}

/**
 * Whether `prefix` is `allowed` or below it, compared segment by segment: `reports-old/x` is not
 * under `reports`. Neither side is decoded, so `%2e%2e` is an ordinary segment.
 */
export function isUnderAllowedPrefix(prefix: string, allowed: string): boolean {
  const segments = prefix.split('/');
  return allowed.split('/').every((segment, index) => segments[index] === segment);
}

/** A run refused because a granted connection folder cannot be delivered (`RUN_START_PROBLEM_CODES`). */
export function storageGrantUnavailable(reason: string): DomainError {
  return new DomainError({
    category: 'validation',
    code: 'run_storage_grant_unavailable',
    publicMessage: `run_storage_grant_unavailable: ${reason}; fix the storage connection or redeploy the agent.`,
  });
}

const WRITE_NOT_ALLOWED = 'storage_connection_write_not_allowed';
const PREFIX_NOT_ALLOWED = 'storage_connection_prefix_not_allowed';

/** The paths of `files` that are well-formed `storage://` grants: the ones step 4a owns. */
export function storageGrantPaths(
  files: readonly { readonly path: string }[],
): ReadonlySet<string> {
  return new Set(
    files.filter((file) => parseStorageGrantPath(file.path) !== null).map((file) => file.path),
  );
}

/** The grants step 4a accepted, with the paths it took over so step 4 does not look them up as files. */
export interface ResolvedStorageGrants {
  readonly grants: readonly StorageGrantRef[];
  readonly paths: ReadonlySet<string>;
}

/**
 * The `storage://` grants in `files` resolved to stored form, or the refusal. A grant whose connection this workspace lacks is `422 agent_definition_references_missing`
 * (`file:<path>`, as step 4 answers a missing file); then any folder outside the connection's
 * allowed folders is `403 storage_connection_prefix_not_allowed`; then a `read-write` grant on a
 * read-only connection is `403 storage_connection_write_not_allowed`. `details` are the refused
 * paths in body order. Without a `lookup` the step takes over nothing and step 4 refuses the path.
 * The stored `connectionId` is the one the lookup resolved, never a client-supplied value.
 */
// @story US-STO-12
export async function resolveStorageGrants(
  files: readonly { readonly path: string; readonly access: 'read' | 'read-write' }[],
  lookup: StorageConnectionLookup | null,
): Promise<ResolvedStorageGrants | { readonly refusal: ApiResult }> {
  const none = { grants: [], paths: new Set<string>() };
  if (lookup === null) return none;
  const grants = files.flatMap((file) => {
    if (!file.path.startsWith(STORAGE_GRANT_SCHEME)) return [];
    const parsed = parseStorageGrantPath(file.path);
    return parsed === null ? [] : [{ ...file, ...parsed }];
  });
  if (grants.length === 0) return none;
  const targets = await lookup(grants.map((grant) => grant.connection));
  const resolved = grants.map((grant) => ({ grant, target: targets.get(grant.connection) }));

  const missing = resolved.filter(({ target }) => target === undefined);
  if (missing.length > 0) {
    return {
      refusal: problem(
        AGENT_VERSION_PROBLEM_CODES.agent_definition_references_missing,
        'agent_definition_references_missing',
        'The definition names resources this workspace does not have.',
        missing.map(({ grant }) => `file:${grant.path}`),
      ),
    };
  }
  const outside = resolved.filter(
    ({ grant, target }) =>
      !target?.allowedPrefixes.some((allowed) => isUnderAllowedPrefix(grant.prefix, allowed)),
  );
  if (outside.length > 0) {
    return {
      refusal: problem(
        AGENT_VERSION_PROBLEM_CODES[PREFIX_NOT_ALLOWED],
        PREFIX_NOT_ALLOWED,
        'The folder is not one the storage connection allows.',
        outside.map(({ grant }) => grant.path),
      ),
    };
  }
  const readOnly = resolved.filter(
    ({ grant, target }) => grant.access === 'read-write' && target?.writeAllowed !== true,
  );
  if (readOnly.length > 0) {
    return {
      refusal: problem(
        AGENT_VERSION_PROBLEM_CODES[WRITE_NOT_ALLOWED],
        WRITE_NOT_ALLOWED,
        'The storage connection does not allow writing.',
        readOnly.map(({ grant }) => grant.path),
      ),
    };
  }
  return {
    grants: resolved.flatMap(({ grant, target }) =>
      target === undefined
        ? []
        : [{ connectionId: target.id, prefix: grant.prefix, access: grant.access }],
    ),
    paths: new Set(grants.map((grant) => grant.path)),
  };
}
