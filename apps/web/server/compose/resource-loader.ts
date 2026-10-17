import type {
  AgentPermissions,
  McpServerConfig,
  RunFileResource,
  RunSkillResource,
} from '@agent-workspace/core';

import type {
  AgentPermissionKey,
  AgentResourceAssignments,
} from '@indx-workspace/contracts/agents';
import { CONNECTOR_DISABLED_RUN_ERROR_CODE } from '@indx-workspace/contracts/connectors';
import {
  POSTGRES_TOOL_OPERATION_NAMES,
  connectorServerKey,
  toolServerKeys,
} from '@indx-workspace/contracts/tool-connectors';

import type { ConnectorsStoreProvider } from '../connectors/store';
import type { WorkspaceObjectStoreProvider } from '../files/store';
import type { ResourceCatalogStoreProvider } from '../resources/catalog-store';
import type { WorkspaceSkillsStoreProvider } from '../skills/store';
import { DomainError } from '../errors';

const EMPTY_FOLDER_MARKER = '.agent-workspace-empty-folder';

/**
 * A tool connector of the run (ADR-0113 C16, C17), keyed by its SD13 server key. Compose turns it
 * into an `http` MCP server at the gateway once the run token exists.
 */
export interface PendingToolConnector {
  readonly key: string;
  readonly connectorId: string;
  /** The connector's name, which a policy ceiling's `tools` allowlist names (C14). */
  readonly name: string;
  readonly operationNames: readonly string[];
}

export interface AgentRunResourceSelection {
  readonly files: readonly RunFileResource[];
  readonly skills: readonly RunSkillResource[];
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  /**
   * The connector name behind each `mcpServers` key, for a policy ceiling's `tools` allowlist
   * (S2-04c). Absent means no names, so a `tools` ceiling drops every MCP entry (fails closed).
   */
  readonly connectorNames?: Readonly<Record<string, string>>;
  /**
   * The `mcpServers` key of each MCP connector by connector id (ADR-0113 SD13, #1109), for rewriting
   * a stored policy rule written against `connector-<id>`. Absent means no rewrite.
   */
  readonly connectorKeys?: Readonly<Record<string, string>>;
  /** Sorted by connector id. Absent means none. */
  readonly toolConnectors?: readonly PendingToolConnector[];
}

/**
 * issue #125: the session's project's `project_files`/`project_mcp_servers` associations, read
 * by id only — the loader resolves what those ids mean (path, catalog row, credential) exactly
 * the same way it already does for an agent's own assignments. Kept this narrow (two lookups,
 * not a `ProjectFileRepositoryProvider`) so this module does not need to know how a workspace id
 * becomes a `WorkspaceScope`; the caller that already has one (`instrumentation-node.ts`) adapts
 * it. See `docs/adr/W9-PROJ-125-project-resources-narrow-never-widen.md`.
 */
export interface ProjectResourceReader {
  listFileIds(workspaceId: string, projectId: string): Promise<readonly string[]>;
  listMcpServerIds(workspaceId: string, projectId: string): Promise<readonly string[]>;
}

export interface AgentRunResourceLoader {
  /**
   * `assignments` are what the run's agent is assigned: its pinned version's, or the agent's own for
   * a legacy session (issue #612). `projectId`/`agentPermissions` are issue #125's addition and are optional so every pre-#125
   * call site (and this file's own pre-#125 tests) keeps compiling and behaving unchanged: no
   * project, no project resources. When a project is given, `agentPermissions` is the ceiling —
   * see {@link AgentRunResourceLoaderDependencies.projectResources}'s doc comment for what "no
   * permission" does. `ceilingCaps` are the switches the deployment's policy ceiling turned off
   * (S2-04c): a project resource refused for one of them is a typed `policy_cannot_widen` refusal
   * naming the ceiling, so the user sees why.
   */
  load(
    workspaceId: string,
    assignments: AgentResourceAssignments,
    projectId?: string | null,
    agentPermissions?: AgentPermissions,
    ceilingCaps?: readonly AgentPermissionKey[],
  ): Promise<AgentRunResourceSelection>;
}

export interface AgentRunResourceLoaderDependencies {
  readonly catalog: ResourceCatalogStoreProvider;
  readonly files?: WorkspaceObjectStoreProvider;
  readonly skills?: WorkspaceSkillsStoreProvider;
  readonly connectors?: ConnectorsStoreProvider;
  /** issue #125. Omitted (or no project on the run) means no project resource is even attempted. */
  readonly projectResources?: ProjectResourceReader;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * The published reserved prefix of the workspace file tree, applied to what a run loads.
 *
 * The same rule `apps/web/server/files/handlers.ts` enforces at `PUT /api/files`, and spelled the
 * same way for the same reason (ADR-0072 D2): it is a statement about the tenant's file tree rather
 * than about one engine's sandbox. The *sandbox* half is the engine's own — the adapter refuses a
 * grant into its `protectedConfigDirectory` (`engine_policy_invalid`) and the runner refuses to
 * materialise one — so a file that reached here past this guard would still not be written.
 */
function assertUserFilePath(path: string): void {
  if (path.split('/', 1)[0]?.toLowerCase() === '.claude') {
    throw new Error(
      `assigned file ${JSON.stringify(path)} collides with the runner's private .claude directory`,
    );
  }
}

async function walkObjectFiles(
  store: ReturnType<WorkspaceObjectStoreProvider['forWorkspace']>,
  prefix: string,
): Promise<readonly { readonly kind: 'file' | 'directory'; readonly path: string }[]> {
  const found: { kind: 'file' | 'directory'; path: string }[] = [];
  const visit = async (at: string): Promise<void> => {
    for (const entry of await store.list(at)) {
      if (entry.kind === 'folder') {
        found.push({ kind: 'directory', path: entry.key });
        await visit(entry.key);
      } else if (!entry.key.endsWith(`/${EMPTY_FOLDER_MARKER}`)) {
        found.push({ kind: 'file', path: entry.key });
      }
    }
  };
  await visit(prefix);
  return found;
}

async function loadFiles(
  workspaceId: string,
  grants: readonly { readonly fileId: string; readonly access: 'read' | 'read-write' }[],
  dependencies: AgentRunResourceLoaderDependencies,
): Promise<readonly RunFileResource[]> {
  if (grants.length === 0) return [];
  if (dependencies.files === undefined) {
    throw new Error('this agent has assigned files, but file storage is not configured');
  }

  const catalog = await dependencies.catalog.forWorkspace(workspaceId);
  const byId = new Map((await catalog.listFiles()).map((file) => [file.id, file]));
  const store = dependencies.files.forWorkspace(workspaceId);
  const direct = new Map<
    string,
    { readonly kind: 'file' | 'directory'; readonly access: 'read' | 'read-write' }
  >();
  const selected = new Map<string, { kind: 'file' | 'directory'; access: 'read' | 'read-write' }>();

  for (const grant of grants) {
    const row = byId.get(grant.fileId);
    if (row === undefined) {
      throw new Error(`assigned file ${grant.fileId} disappeared before the run was composed`);
    }
    assertUserFilePath(row.path);
    direct.set(row.path, {
      kind: row.kind === 'folder' ? 'directory' : 'file',
      access: grant.access,
    });
    selected.set(row.path, {
      kind: row.kind === 'folder' ? 'directory' : 'file',
      access: grant.access,
    });
    if (row.kind === 'folder') {
      for (const child of await walkObjectFiles(store, row.path)) {
        assertUserFilePath(child.path);
        const existing = selected.get(child.path);
        if (existing === undefined) selected.set(child.path, { ...child, access: grant.access });
      }
    }
  }

  // Explicit grants are applied broadest-to-narrowest. A child directory grant governs its whole
  // subtree, while an even more specific descendant grant can still override it afterward.
  const explicit = [...direct].sort(
    ([left], [right]) => left.split('/').length - right.split('/').length,
  );
  for (const [path, grant] of explicit) {
    for (const [selectedPath, item] of selected) {
      if (
        selectedPath === path ||
        (grant.kind === 'directory' && selectedPath.startsWith(`${path}/`))
      ) {
        selected.set(selectedPath, { ...item, access: grant.access });
      }
    }
  }

  const out: RunFileResource[] = [];
  for (const [path, selectedFile] of [...selected].sort(([a], [b]) => a.localeCompare(b))) {
    if (selectedFile.kind === 'directory') {
      out.push({ kind: 'directory', path, access: selectedFile.access });
      continue;
    }
    const object = await store.get(path);
    if (object === null)
      throw new Error(`assigned file ${JSON.stringify(path)} has no stored bytes`);
    out.push({
      kind: 'file',
      path,
      access: selectedFile.access,
      contentBase64: base64(object.body),
    });
  }
  return out;
}

async function loadSkills(
  workspaceId: string,
  skillIds: readonly string[],
  dependencies: AgentRunResourceLoaderDependencies,
): Promise<readonly RunSkillResource[]> {
  if (skillIds.length === 0) return [];
  if (dependencies.skills === undefined) {
    throw new Error('this agent has assigned skills, but skill storage is not configured');
  }

  const catalog = await dependencies.catalog.forWorkspace(workspaceId);
  const byId = new Map((await catalog.listSkills()).map((skill) => [skill.id, skill]));
  const store = dependencies.skills.forWorkspace(workspaceId);
  const out: RunSkillResource[] = [];
  for (const skillId of skillIds) {
    const skill = byId.get(skillId);
    if (skill === undefined) {
      throw new Error(`assigned skill ${skillId} disappeared before the run was composed`);
    }
    if (!skill.enabled) continue;
    const prefix = `skills/${skill.name}`;
    const walked = await walkObjectFiles(store, prefix);
    const files: { path: string; contentBase64: string }[] = [];
    for (const entry of walked) {
      if (entry.kind === 'directory') continue;
      const object = await store.get(entry.path);
      if (object === null) {
        throw new Error(`assigned skill file ${JSON.stringify(entry.path)} has no stored bytes`);
      }
      files.push({ path: entry.path.slice(prefix.length + 1), contentBase64: base64(object.body) });
    }
    if (!files.some((file) => file.path === 'SKILL.md')) {
      throw new Error(`assigned skill ${JSON.stringify(skill.name)} has no SKILL.md`);
    }
    out.push({ name: skill.name, files });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

type LoadedConnectors = Pick<
  AgentRunResourceSelection,
  'mcpServers' | 'connectorNames' | 'connectorKeys' | 'toolConnectors'
>;

async function loadConnectors(
  workspaceId: string,
  connectorIds: readonly string[],
  projectConnectorIds: ReadonlySet<string>,
  dependencies: AgentRunResourceLoaderDependencies,
): Promise<LoadedConnectors> {
  if (connectorIds.length === 0) return { mcpServers: {} };
  if (dependencies.connectors === undefined) {
    throw new Error('this agent has assigned connectors, but connector storage is not configured');
  }

  const store = dependencies.connectors.forWorkspace(workspaceId);
  const mcps: {
    readonly id: string;
    readonly name: string;
    readonly config: McpServerConfig;
  }[] = [];
  const tools: { connectorId: string; name: string; operationNames: readonly string[] }[] = [];
  for (const connectorId of connectorIds) {
    const [connector, probe] = await Promise.all([
      store.get(connectorId),
      store.resolveForProbe(connectorId),
    ]);
    if (connector === null) {
      throw new Error(`assigned connector ${connectorId} disappeared before the run was composed`);
    }
    // A disabled connector is refused, not dropped: a run that silently lost a tool its agent was
    // configured with would fail later and further from the cause (#240). The same holds for one a
    // project association brings in (issue #125), so the message names both sources.
    if (!connector.enabled) {
      throw new DomainError({
        category: 'conflict',
        code: CONNECTOR_DISABLED_RUN_ERROR_CODE,
        publicMessage:
          `${CONNECTOR_DISABLED_RUN_ERROR_CODE}: connector ${connector.id} is disabled; ` +
          'enable it, or remove it from the agent or the project that brings it into this run',
      });
    }
    if (connector.kind === 'openapi' || connector.kind === 'postgres') {
      // #586: a project binds MCP connectors only, and its write path refuses a tool connector; a
      // binding written before that refusal is refused here rather than handed to the engine.
      if (projectConnectorIds.has(connector.id)) {
        throw new DomainError({
          category: 'validation',
          code: 'project_connector_not_mcp',
          publicMessage:
            `project_connector_not_mcp: connector ${connector.id} is a ${connector.kind} tool ` +
            'connector; remove it from the project and assign it to the agent instead',
        });
      }
      const needsCredential =
        connector.kind === 'postgres' || (connector.openapi?.auth ?? 'none') !== 'none';
      if (needsCredential && !connector.hasCredential) {
        throw new Error(
          `assigned connector ${JSON.stringify(connector.name)} has no resolvable credential`,
        );
      }
      tools.push({
        connectorId: connector.id,
        name: connector.name,
        operationNames:
          connector.kind === 'postgres'
            ? [...POSTGRES_TOOL_OPERATION_NAMES]
            : (connector.openapi?.operations ?? []).map((operation) => operation.name),
      });
      continue;
    }
    if (probe === null) {
      throw new Error(`assigned connector ${JSON.stringify(connector.name)} could not be resolved`);
    }
    if (connector.authType !== 'none' && !probe.credentialConfigured) {
      throw new Error(
        `assigned connector ${JSON.stringify(connector.name)} has no resolvable credential`,
      );
    }
    mcps.push({
      id: connector.id,
      name: connector.name,
      config:
        probe.transport === 'stdio'
          ? {
              type: 'stdio',
              command: probe.command,
              args: [...probe.args],
              ...(Object.keys(probe.env).length === 0 ? {} : { env: { ...probe.env } }),
            }
          : {
              type: probe.transport,
              url: probe.url,
              ...(Object.keys(probe.headers).length === 0 ? {} : { headers: { ...probe.headers } }),
            },
    });
  }
  // SD13 orders a run's colliding names by connector id.
  tools.sort((a, b) => (a.connectorId < b.connectorId ? -1 : 1));
  const keys = toolServerKeys(tools.map((tool) => tool.name));
  // Tool keys are fixed first; an MCP connector whose name spells one falls back to its id (#1109).
  const taken = new Set(keys);
  const configs: Record<string, McpServerConfig> = {};
  const names: Record<string, string> = {};
  const connectorKeys: Record<string, string> = {};
  for (const mcp of mcps) {
    const key = connectorServerKey(mcp.name, mcp.id, taken);
    configs[key] = mcp.config;
    names[key] = mcp.name;
    connectorKeys[mcp.id] = key;
  }
  if (tools.length === 0) return { mcpServers: configs, connectorNames: names, connectorKeys };
  return {
    mcpServers: configs,
    connectorNames: names,
    connectorKeys,
    toolConnectors: tools.map((tool, index) => {
      const key = keys[index];
      if (key === undefined) throw new Error('toolServerKeys returned fewer keys than names');
      return {
        key,
        connectorId: tool.connectorId,
        name: tool.name,
        operationNames: tool.operationNames,
      };
    }),
  };
}

/**
 * The project's read-only file grants, or the pre-launch refusal for #125's narrowing rule.
 *
 * `project_files` is a bare id list (ADR: `W9-PLAN-project-file-grants-are-read-only-in-wave-9`),
 * so every id it names becomes a `'read'` grant — never `'read-write'`, structurally, because
 * nothing here ever produces that value for a project-sourced id. Grants are returned **ahead of**
 * the agent's own in the array `loadFiles` merges: that function already applies the shallowest
 * grant first and lets a deeper, more specific grant repaint its own subtree (see its own tests),
 * so putting the project's grants first and the agent's own after — unchanged — makes the agent's
 * own explicit assignment win whenever it names the same id or a deeper path, and lets the
 * project's grant win a subtree the agent only reaches through a shallower grant of its own. That
 * is #125's "agent wins for the same file id, the more restrictive mode wins for the same path"
 * in one existing algorithm, not a second one.
 *
 * The ceiling is `agentPermissions.readFiles`: a project cannot hand an agent file access its own
 * tool permissions do not include, so any project file association is refused outright (not
 * silently dropped — see the loader's own doc comment) when that permission is off.
 */
async function loadProjectFileGrants(
  workspaceId: string,
  projectId: string,
  agentPermissions: AgentPermissions | undefined,
  ceilingCaps: readonly AgentPermissionKey[],
  dependencies: AgentRunResourceLoaderDependencies,
): Promise<readonly { readonly fileId: string; readonly access: 'read' }[]> {
  if (dependencies.projectResources === undefined) return [];
  const fileIds = await dependencies.projectResources.listFileIds(workspaceId, projectId);
  if (fileIds.length === 0) return [];
  if (agentPermissions?.readFiles !== true) {
    if (ceilingCaps.includes('readFiles')) {
      throw ceilingCappedProjectResource(
        projectId,
        `${String(fileIds.length)} file(s)/folder(s)`,
        'readFiles',
      );
    }
    throw new Error(
      `project ${projectId} associates ${String(fileIds.length)} file(s)/folder(s), but the ` +
        'agent running this session does not have the readFiles tool permission — a project ' +
        "association can only narrow an agent's own permissions, never widen them.",
    );
  }
  return fileIds.map((fileId) => ({ fileId, access: 'read' as const }));
}

/** The refusal of a project resource whose switch the deployment's policy ceiling turned off. */
function ceilingCappedProjectResource(
  projectId: string,
  associates: string,
  key: AgentPermissionKey,
): DomainError {
  return new DomainError({
    category: 'validation',
    code: 'policy_cannot_widen',
    publicMessage:
      `policy_cannot_widen: project ${projectId} associates ${associates}, but this deployment's ` +
      `policy ceiling caps permissions.${key}. Remove the association from the project, or ask ` +
      'an administrator to raise the ceiling.',
  });
}

/**
 * The project's connector ids, or the pre-launch refusal for #125's narrowing rule.
 *
 * The ceiling is `agentPermissions.unrestrictedNetwork` — an MCP connector is a network egress,
 * and #125 asks that "a project connector whose credential the agent is not authorised for is
 * dropped and reported as a pre-launch error"; this codebase has no per-agent, per-connector
 * authorisation narrower than that tool permission, so that is the check. Whether the resulting
 * connector is actually usable (enabled, has a resolvable credential) is `loadConnectors`'s own,
 * unchanged, check — applied identically to a project-sourced id and an agent-assigned one.
 */
async function loadProjectConnectorIds(
  workspaceId: string,
  projectId: string,
  agentPermissions: AgentPermissions | undefined,
  ceilingCaps: readonly AgentPermissionKey[],
  dependencies: AgentRunResourceLoaderDependencies,
): Promise<readonly string[]> {
  if (dependencies.projectResources === undefined) return [];
  const connectorIds = await dependencies.projectResources.listMcpServerIds(workspaceId, projectId);
  if (connectorIds.length === 0) return [];
  if (agentPermissions?.unrestrictedNetwork !== true) {
    if (ceilingCaps.includes('unrestrictedNetwork')) {
      throw ceilingCappedProjectResource(
        projectId,
        `${String(connectorIds.length)} connector(s)`,
        'unrestrictedNetwork',
      );
    }
    throw new Error(
      `project ${projectId} associates ${String(connectorIds.length)} connector(s), but the ` +
        'agent running this session does not have the unrestrictedNetwork tool permission, so ' +
        "it is not authorised for those connectors' credentials.",
    );
  }
  return connectorIds;
}

export function createAgentRunResourceLoader(
  dependencies: AgentRunResourceLoaderDependencies,
): AgentRunResourceLoader {
  return {
    async load(
      workspaceId,
      assignments,
      projectId = null,
      agentPermissions = undefined,
      ceilingCaps = [],
    ) {
      const [projectFileGrants, projectConnectorIds] =
        projectId === null || projectId === undefined
          ? [[], []]
          : await Promise.all([
              loadProjectFileGrants(
                workspaceId,
                projectId,
                agentPermissions,
                ceilingCaps,
                dependencies,
              ),
              loadProjectConnectorIds(
                workspaceId,
                projectId,
                agentPermissions,
                ceilingCaps,
                dependencies,
              ),
            ]);
      // A connector the agent is assigned is the agent's own, even when the project names it too.
      const agentConnectorIds = new Set(assignments.connectorIds);
      const [files, skills, connectors] = await Promise.all([
        loadFiles(workspaceId, [...projectFileGrants, ...assignments.files], dependencies),
        loadSkills(workspaceId, assignments.skillIds, dependencies),
        loadConnectors(
          workspaceId,
          [...new Set([...projectConnectorIds, ...assignments.connectorIds])],
          new Set(projectConnectorIds.filter((id) => !agentConnectorIds.has(id))),
          dependencies,
        ),
      ]);
      return { files, skills, ...connectors };
    },
  };
}
