/**
 * The pure halves of the agent version store (#442, S1-04, ADR-0101): resolving a definition's
 * names against the rows that match them, and the #133 `writeFiles` ceiling.
 *
 * They are split from `./agent-versions.ts` so they can be tested without PostgreSQL, and so the
 * web application's in-memory version store applies the same rules rather than restating them. That matters
 * for the ambiguous arm in particular: every name and path a definition uses is unique per
 * workspace (`skills_workspace_name_key`, `mcp_servers_workspace_name_key`,
 * `files_workspace_path_key`, `model_connections_workspace_name_key`,
 * `runtime_profiles_workspace_name_key`), so a real database cannot produce two matches today. The
 * arm exists so that the day one of those keys is relaxed, a definition naming a duplicate is
 * refused rather than resolved to whichever row came back first — the same rule
 * `packages/sdk/src/resources/agent-definitions.ts` applies on import.
 */
import type { FileAccessMode } from '../schema/agent-files.js';
import type { AgentPermissions } from '../schema/agents.js';

/**
 * The kinds of reference a definition makes. The database's copy of `@indx-workspace/contracts`'
 * `AGENT_DEFINITION_REFERENCE_KINDS`, in the same order, restated by hand.
 */
export const agentDefinitionReferenceKinds = [
  'skill',
  'connector',
  'file',
  'model-connection',
  'runtime-profile',
] as const;
export type AgentDefinitionReferenceKind = (typeof agentDefinitionReferenceKinds)[number];

/** One reference a definition makes by name (a file's name is its path). */
export interface DefinitionReference {
  readonly kind: AgentDefinitionReferenceKind;
  readonly name: string;
}

/** A candidate row a name may match: its id and the name (or path) it is known by. */
export interface NamedRow {
  readonly id: string;
  readonly name: string;
}

/** What matching a list of names against a list of rows found. */
export interface ReferenceMatches {
  /** `name → id` for every name that matched exactly one row. */
  readonly ids: ReadonlyMap<string, string>;
  /** Names that matched no row, in the order the definition lists them, without repeats. */
  readonly missing: readonly DefinitionReference[];
  /** Names that matched more than one row, in the order the definition lists them. */
  readonly ambiguous: readonly DefinitionReference[];
}

/**
 * Match `names` against `rows` by exact equality, as SDK import does.
 *
 * One match resolves; none is missing; more than one is ambiguous and is never resolved to the
 * first, because choosing would be choosing for the caller.
 */
export function classifyReferenceMatches(
  kind: AgentDefinitionReferenceKind,
  names: readonly string[],
  rows: readonly NamedRow[],
): ReferenceMatches {
  const ids = new Map<string, string>();
  const missing: DefinitionReference[] = [];
  const ambiguous: DefinitionReference[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) continue;
    seen.add(name);
    const matches = rows.filter((row) => row.name === name);
    const only = matches[0];
    if (matches.length > 1) ambiguous.push({ kind, name });
    else if (only === undefined) missing.push({ kind, name });
    else ids.set(name, only.id);
  }
  return { ids, missing, ambiguous };
}

/** One file grant, by id. */
export interface FileGrant {
  readonly fileId: string;
  readonly access: FileAccessMode;
}

/**
 * Issue #133's ceiling: when the agent's own `writeFiles` permission is off, every `'read-write'`
 * grant is narrowed to `'read'` (narrowed, never refused — see `./agent-resources.ts`). A file
 * listed twice keeps one grant, the wider of the two before the ceiling is applied, so the
 * `agent_files_workspace_agent_file_key` unique key never sees a duplicate.
 */
export function narrowFileGrants(
  grants: readonly FileGrant[],
  permissions: AgentPermissions,
): readonly FileGrant[] {
  const byId = new Map<string, FileAccessMode>();
  for (const grant of grants) {
    const previous = byId.get(grant.fileId);
    byId.set(grant.fileId, previous === 'read-write' ? 'read-write' : grant.access);
  }
  return [...byId].map(([fileId, access]) => ({
    fileId,
    access: permissions.writeFiles || access === 'read' ? access : 'read',
  }));
}

/** The by-name references a definition makes (a file by path). */
export interface DefinitionReferences {
  /** `null` or `'default'` follows C7; see {@link resolveModelConnection}. */
  readonly modelConnectionName: string | null;
  /**
   * `null` means "the workspace's default runtime profile at the moment the version is applied",
   * and "none" when the workspace has no default (issue #504). Never reported missing.
   */
  readonly runtimeProfileName: string | null;
  readonly skills: readonly string[];
  readonly connectors: readonly string[];
  readonly files: readonly { readonly path: string; readonly access: FileGrant['access'] }[];
}

/** The same references, resolved to this workspace's ids. */
export interface ResolvedReferences {
  readonly modelConnectionId: string | null;
  /**
   * The named profile's id; for a `null` name, the workspace's default profile's id, or `null`
   * when the workspace has none (the agent then stays refused by run preflight).
   */
  readonly runtimeProfileId: string | null;
  readonly skillIds: readonly string[];
  readonly connectorIds: readonly string[];
  readonly files: readonly FileGrant[];
}

export type ResolveDefinitionOutcome =
  | { readonly kind: 'resolved'; readonly references: ResolvedReferences }
  | {
      readonly kind: 'unresolved';
      readonly missing: readonly DefinitionReference[];
      readonly ambiguous: readonly DefinitionReference[];
    };

/** The candidate rows of each kind; an absent kind has none. */
type ReferenceRows = Partial<Record<AgentDefinitionReferenceKind, readonly NamedRow[]>>;

/**
 * C7: `null` and `'default'` mean "the connection named `default`, else the deployment default".
 * Any other name must match exactly one connection.
 */
function resolveModelConnection(
  name: string | null,
  rows: readonly NamedRow[],
):
  | { readonly kind: 'resolved'; readonly id: string | null }
  | { readonly kind: 'unresolved'; readonly matches: ReferenceMatches } {
  const wanted = name ?? 'default';
  const matches = classifyReferenceMatches('model-connection', [wanted], rows);
  const id = matches.ids.get(wanted);
  if (id !== undefined) return { kind: 'resolved', id };
  if (wanted === 'default' && matches.ambiguous.length === 0) return { kind: 'resolved', id: null };
  return { kind: 'unresolved', matches };
}

function idsOf(names: readonly string[], ids: ReadonlyMap<string, string>): readonly string[] {
  return [...new Set(names)].flatMap((name) => {
    const id = ids.get(name);
    return id === undefined ? [] : [id];
  });
}

/**
 * Resolve a definition's references against the rows their names match. Missing and ambiguous
 * names are reported in kind order (skill, connector, file, model connection, runtime profile),
 * each kind in the order the definition lists them.
 *
 * A `null` runtime profile name is `defaultRuntimeProfileId` (issue #504), never missing. If that
 * default is deleted before the agent row is written, the agents foreign key reports it as
 * `reference-gone`, exactly like a named profile deleted in the same window.
 */
export function resolveFromRows(
  references: DefinitionReferences,
  rows: ReferenceRows,
  defaultRuntimeProfileId: string | null,
): ResolveDefinitionOutcome {
  const filePaths = references.files.map((grant) => grant.path);
  const profileNames =
    references.runtimeProfileName === null ? [] : [references.runtimeProfileName];
  const skillMatches = classifyReferenceMatches('skill', references.skills, rows.skill ?? []);
  const connectorMatches = classifyReferenceMatches(
    'connector',
    references.connectors,
    rows.connector ?? [],
  );
  const fileMatches = classifyReferenceMatches('file', filePaths, rows.file ?? []);
  const connection = resolveModelConnection(
    references.modelConnectionName,
    rows['model-connection'] ?? [],
  );
  const profileMatches = classifyReferenceMatches(
    'runtime-profile',
    profileNames,
    rows['runtime-profile'] ?? [],
  );

  const all = [
    skillMatches,
    connectorMatches,
    fileMatches,
    ...(connection.kind === 'unresolved' ? [connection.matches] : []),
    profileMatches,
  ];
  const missing = all.flatMap((matches) => matches.missing);
  const ambiguous = all.flatMap((matches) => matches.ambiguous);
  if (connection.kind === 'unresolved' || missing.length > 0 || ambiguous.length > 0) {
    return { kind: 'unresolved', missing, ambiguous };
  }
  return {
    kind: 'resolved',
    references: {
      modelConnectionId: connection.id,
      runtimeProfileId:
        references.runtimeProfileName === null
          ? defaultRuntimeProfileId
          : (profileMatches.ids.get(references.runtimeProfileName) ?? null),
      skillIds: idsOf(references.skills, skillMatches.ids),
      connectorIds: idsOf(references.connectors, connectorMatches.ids),
      files: references.files.flatMap((grant) => {
        const fileId = fileMatches.ids.get(grant.path);
        return fileId === undefined ? [] : [{ fileId, access: grant.access }];
      }),
    },
  };
}
