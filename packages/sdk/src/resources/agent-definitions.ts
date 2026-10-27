import {
  AGENT_DEFINITION_API_VERSION,
  AGENT_DEFINITION_KIND,
  AGENT_DEFINITION_ORPHAN_DETAIL_PREFIX,
  AGENT_DEFINITION_PROBLEM_CODES,
  AgentDefinitionSchema,
  AgentPolicyResponseSchema,
  type AgentDefinition,
  type AgentDefinitionOnMissing,
  type AgentDefinitionProblemCode,
  type AgentDefinitionReferenceKind,
  type AgentPolicy,
  type AgentPolicyResponse,
  type AgentResource,
  type AgentResourceAssignments,
} from '@indx-workspace/contracts/agents';
import type { FileResource } from '@indx-workspace/contracts/files';

import { ApiProblemError } from '../errors.js';
import { segment, type HttpClient, type RequestOptions } from '../http.js';
import type { AgentsClient } from './agents.js';
import { ConnectorsClient } from './connectors.js';
import { EnginesClient } from './engines.js';
import { FilesClient } from './files.js';
import { ModelConnectionsClient } from './models.js';
import { RuntimeProfilesClient } from './runtimes.js';
import { SkillsClient } from './skills.js';

/** Options of `agents.import`. */
export interface ImportAgentDefinitionOptions extends RequestOptions {
  /** What to do with a name the destination does not have. Default `'fail'`. */
  readonly onMissing?: AgentDefinitionOnMissing;
}

/** What `agents.import` created, and every reference it dropped under `onMissing: 'skip'`. */
export interface ImportAgentDefinitionResult {
  readonly agent: AgentResource;
  readonly assignments: AgentResourceAssignments;
  readonly policy: AgentPolicy;
  /** `<kind>:<name>` for each reference left out; always empty under `onMissing: 'fail'`. */
  readonly skipped: readonly string[];
}

/**
 * The most folders `export` lists while it looks for the paths of an agent's file grants. The
 * files routes list one level at a time and have no "path of id" lookup, so the walk is bounded
 * rather than allowed to read an entire large workspace; a grant it cannot place is refused by
 * name, never silently dropped.
 */
const AGENT_DEFINITION_FILE_WALK_MAX_FOLDERS = 500;

/** How many folder listings of one breadth-first level `export` has in flight at once. */
const AGENT_DEFINITION_FILE_WALK_CONCURRENCY = 16;

function refusal(
  code: AgentDefinitionProblemCode,
  message: string,
  details: readonly string[],
): ApiProblemError {
  return new ApiProblemError({
    status: AGENT_DEFINITION_PROBLEM_CODES[code],
    problem: { code, message, details },
  });
}

/** Only the signal: `options` may carry `onMissing`, which no single route takes. */
function requestOptions(options: RequestOptions): RequestOptions {
  return options.signal === undefined ? {} : { signal: options.signal };
}

function reference(kind: AgentDefinitionReferenceKind, name: string): string {
  return `${kind}:${name}`;
}

/**
 * The error an import throws when it created `agentId`, a later step failed with `failure`, and
 * removing the agent again failed with `removal`: the original refusal stays the primary error,
 * with the orphan named in `details`, so the caller can remove it (ADR-0076 D4).
 */
function orphaned(agentId: string, failure: unknown, removal: unknown): ApiProblemError {
  const orphan = `${AGENT_DEFINITION_ORPHAN_DETAIL_PREFIX}${agentId}`;
  if (failure instanceof ApiProblemError) {
    return new ApiProblemError({
      status: failure.status,
      problem: {
        code: failure.code,
        message: failure.message,
        details: [...failure.details, orphan],
      },
      retryAfterSeconds: failure.retryAfterSeconds,
      cause: removal,
    });
  }
  return new ApiProblemError({
    status: AGENT_DEFINITION_PROBLEM_CODES.agent_definition_import_incomplete,
    problem: {
      code: 'agent_definition_import_incomplete',
      message:
        'The import failed after the agent was created, and the agent could not be removed again; remove it by the id in details.',
      details: [orphan],
    },
    cause: failure,
  });
}

function parentOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * K-1 (spec 04 §6.2, ADR-0076): export and import compose existing routes — nothing new is asked
 * of the server, and so every read and write goes through the same role checks as the individual
 * calls it is made of. The destination is simply whichever workspace the client's credential is
 * bound to.
 */
export class AgentDefinitions {
  readonly #http: HttpClient;
  readonly #agents: AgentsClient;
  readonly #skills: SkillsClient;
  readonly #connectors: ConnectorsClient;
  readonly #modelConnections: ModelConnectionsClient;
  readonly #runtimeProfiles: RuntimeProfilesClient;
  readonly #files: FilesClient;
  readonly #engines: EnginesClient;

  public constructor(http: HttpClient, agents: AgentsClient) {
    this.#http = http;
    this.#agents = agents;
    this.#skills = new SkillsClient(http);
    this.#connectors = new ConnectorsClient(http);
    this.#modelConnections = new ModelConnectionsClient(http);
    this.#runtimeProfiles = new RuntimeProfilesClient(http);
    this.#files = new FilesClient(http);
    this.#engines = new EnginesClient(http);
  }

  public async export(agentId: string, options: RequestOptions = {}): Promise<AgentDefinition> {
    const request = requestOptions(options);
    const [agent, policy, assignments] = await Promise.all([
      this.#agents.get(agentId, request),
      this.#policyOf(agentId, request),
      this.#agents.getResourceAssignments(agentId, request),
    ]);
    const [modelConnectionName, runtimeProfileName, skills, connectors, files] = await Promise.all([
      agent.modelConnectionId === null
        ? null
        : this.#modelConnections.get(agent.modelConnectionId, request).then((row) => row.name),
      agent.runtimeProfileId === null
        ? null
        : this.#runtimeProfiles.get(agent.runtimeProfileId, request).then((row) => row.name),
      assignments.skillIds.length === 0 ? [] : this.#skills.list(request),
      assignments.connectorIds.length === 0 ? [] : this.#connectors.list(request),
      this.#filePaths(
        assignments.files.map((grant) => grant.fileId),
        request,
      ),
    ]);

    const unresolvable: string[] = [];
    const namesOf = (
      kind: AgentDefinitionReferenceKind,
      ids: readonly string[],
      rows: readonly { readonly id: string; readonly name: string }[],
    ): string[] =>
      ids.flatMap((id) => {
        const name = rows.find((row) => row.id === id)?.name;
        if (name === undefined) unresolvable.push(reference(kind, id));
        return name === undefined ? [] : [name];
      });
    const skillNames = namesOf('skill', assignments.skillIds, skills);
    const skillPins = Object.entries(assignments.skillRevisions ?? {}).flatMap(([id, revision]) => {
      const name = skills.find((row) => row.id === id)?.name;
      return name === undefined ? [] : [[name, revision] as const];
    });
    const connectorNames = namesOf('connector', assignments.connectorIds, connectors);
    const fileGrants = assignments.files.flatMap((grant) => {
      const path = files.get(grant.fileId);
      if (path === undefined) unresolvable.push(reference('file', grant.fileId));
      return path === undefined ? [] : [{ path, access: grant.access }];
    });
    if (unresolvable.length > 0) {
      throw refusal(
        'agent_definition_reference_unresolvable',
        'The agent is assigned resources whose names could not be read back, so no portable definition was produced.',
        unresolvable,
      );
    }

    return AgentDefinitionSchema.parse({
      apiVersion: AGENT_DEFINITION_API_VERSION,
      kind: AGENT_DEFINITION_KIND,
      agent: {
        name: agent.name,
        instructions: agent.instructions,
        permissions: agent.permissions,
        model: agent.model,
        modelConnectionName,
        runtimeProfileName,
      },
      // A stored allowlist can outlive an assignment it named; a run intersects it with the
      // current assignments anyway, so only the assigned names are carried.
      policy:
        policy.policy.skills.mode === 'allowlist'
          ? {
              ...policy.policy,
              skills: {
                mode: 'allowlist',
                names: policy.policy.skills.names.filter((name) => skillNames.includes(name)),
              },
            }
          : policy.policy,
      // A server older than #239 does not say; 'stored' keeps the policy exactly as read.
      policySource: policy.source ?? 'stored',
      resources: {
        files: fileGrants,
        skills: skillNames,
        ...(skillPins.length === 0 ? {} : { skillRevisions: Object.fromEntries(skillPins) }),
        connectors: connectorNames,
      },
    });
  }

  public async import(
    raw: unknown,
    options: ImportAgentDefinitionOptions = {},
  ): Promise<ImportAgentDefinitionResult> {
    const parsed = AgentDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      throw refusal(
        'invalid_agent_definition',
        `The agent definition does not match the ${AGENT_DEFINITION_API_VERSION} AgentDefinition shape.`,
        parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
      );
    }
    const definition = parsed.data;
    const skip = (options.onMissing ?? 'fail') === 'skip';
    const request = requestOptions(options);

    const engines = await this.#engines.list(request);
    if (!engines.some((engine) => engine.id === definition.policy.engine && engine.installed)) {
      throw refusal(
        'unsupported_engine',
        'The definition runs on an engine this deployment does not install.',
        [definition.policy.engine],
      );
    }

    const { agent, resources } = definition;
    const [skills, connectors, modelConnections, runtimeProfiles, files] = await Promise.all([
      resources.skills.length === 0 ? [] : this.#skills.list(request),
      resources.connectors.length === 0 ? [] : this.#connectors.list(request),
      agent.modelConnectionName === null ? [] : this.#modelConnections.list(request),
      agent.runtimeProfileName === null ? [] : this.#runtimeProfiles.list(request),
      this.#filesAt(
        resources.files.map((grant) => grant.path),
        request,
      ),
    ]);

    const missing: string[] = [];
    const ambiguous: string[] = [];
    const resolve = (
      kind: AgentDefinitionReferenceKind,
      name: string,
      rows: readonly { readonly id: string; readonly name: string }[],
    ): string | null => {
      const matches = rows.filter((row) => row.name === name);
      if (matches.length > 1) ambiguous.push(reference(kind, name));
      else if (matches.length === 0) missing.push(reference(kind, name));
      return matches.length === 1 ? (matches[0]?.id ?? null) : null;
    };

    const skillIds = new Map<string, string>();
    const skippedSkills = new Set<string>();
    for (const name of resources.skills) {
      const id = resolve('skill', name, skills);
      if (id === null) skippedSkills.add(name);
      else skillIds.set(name, id);
    }
    const connectorIds = resources.connectors.flatMap((name) => {
      const id = resolve('connector', name, connectors);
      return id === null ? [] : [id];
    });
    const fileGrants = resources.files.flatMap((grant) => {
      const id = files.get(grant.path);
      if (id === undefined) missing.push(reference('file', grant.path));
      return id === undefined ? [] : [{ fileId: id, access: grant.access }];
    });
    const modelConnectionId =
      agent.modelConnectionName === null
        ? null
        : resolve('model-connection', agent.modelConnectionName, modelConnections);
    const runtimeProfileId =
      agent.runtimeProfileName === null
        ? null
        : resolve('runtime-profile', agent.runtimeProfileName, runtimeProfiles);

    // Ambiguity is refused whatever `onMissing` says: skipping would be choosing for the caller.
    if (ambiguous.length > 0) {
      throw refusal(
        'agent_definition_reference_ambiguous',
        'More than one resource in this workspace has a name the definition uses; rename one and import again.',
        ambiguous,
      );
    }
    if (missing.length > 0 && !skip) {
      throw refusal(
        'agent_definition_references_missing',
        'The definition names resources this workspace does not have; nothing was created.',
        missing,
      );
    }

    // A skipped skill leaves the allowlist too: the policy route refuses an allowlist entry the
    // agent has no assignment for (`409 skill_not_assigned`). Only a skipped name is removed — the
    // contract already refuses an allowlist naming a skill `resources.skills` does not assign, so
    // under `'fail'` the allowlist is sent exactly as written.
    const policy: AgentPolicy =
      definition.policy.skills.mode === 'allowlist'
        ? {
            ...definition.policy,
            skills: {
              mode: 'allowlist',
              names: definition.policy.skills.names.filter((name) => !skippedSkills.has(name)),
            },
          }
        : definition.policy;

    // A skipped skill is not assigned, so its pin goes with it.
    const skillRevisions = Object.fromEntries(
      Object.entries(resources.skillRevisions ?? {}).flatMap(([name, revision]) => {
        const id = skillIds.get(name);
        return id === undefined ? [] : [[id, revision] as const];
      }),
    );

    const created = await this.#agents.create(
      {
        name: agent.name,
        instructions: agent.instructions,
        permissions: agent.permissions,
        model: agent.model,
        modelConnectionId,
        runtimeProfileId,
      },
      {
        assignments: {
          files: fileGrants,
          skillIds: [...skillIds.values()],
          ...(Object.keys(skillRevisions).length === 0 ? {} : { skillRevisions }),
          connectorIds,
        },
        ...request,
      },
    );
    let stored: AgentPolicy;
    try {
      // ADR-0076 D2: only a policy the source stored is stored here. A compiled one stays
      // compiled, so it keeps following the destination agent's permissions and skills; it is
      // read back only to report it.
      stored =
        definition.policySource === 'stored'
          ? await this.#agents.replacePolicy(created.agent.id, policy, request)
          : await this.#agents.getPolicy(created.agent.id, request);
      // A compiled policy is the destination's to derive, on the engine it compiles for. A file
      // that says `'compiled'` for another engine (only a hand-written one can: export records
      // what the server answered) would otherwise leave the agent on a different engine than the
      // definition names, without its `withheldPermissions` (ADR-0074 D12). Refused inside this
      // `try`, so the agent just created is removed again.
      if (stored.engine !== definition.policy.engine) {
        throw refusal(
          'invalid_agent_definition',
          `A compiled policy runs on '${stored.engine}' in this workspace, not on '${definition.policy.engine}'; set policySource to 'stored' to import the '${definition.policy.engine}' policy.`,
          [`policySource: a compiled policy cannot name the engine '${definition.policy.engine}'`],
        );
      }
    } catch (error) {
      // Compensate so a refused import leaves nothing behind: re-running it must not make a
      // second agent. The removal takes no signal, so an abort still cleans up. When it fails
      // too, the original refusal is still what is thrown, naming the agent left behind.
      const removal = await this.#agents.remove(created.agent.id).then(
        () => null,
        (failure: unknown) => ({ failure }),
      );
      if (removal === null) throw error;
      throw orphaned(created.agent.id, error, removal.failure);
    }
    return {
      agent: created.agent,
      assignments: created.assignments,
      policy: stored,
      skipped: missing,
    };
  }

  /** `GET /api/agents/:id/policy` with the `source` `agents.getPolicy` does not return. */
  async #policyOf(agentId: string, request: RequestOptions): Promise<AgentPolicyResponse> {
    return this.#http.json({
      operation: 'agents.export',
      method: 'GET',
      path: `/api/agents/${segment(agentId)}/policy`,
      expect: [200],
      schema: AgentPolicyResponseSchema,
      signal: request.signal,
    });
  }

  /**
   * Map each file-grant id to its workspace path by walking folders breadth-first: the folders of
   * one level are listed concurrently, a few at a time, and the walk stops once every id is found
   * or {@link AGENT_DEFINITION_FILE_WALK_MAX_FOLDERS} folders have been listed.
   */
  async #filePaths(
    fileIds: readonly string[],
    request: RequestOptions,
  ): Promise<ReadonlyMap<string, string>> {
    const found = new Map<string, string>();
    const wanted = new Set(fileIds);
    let pending: (string | undefined)[] = [undefined];
    let listed = 0;
    while (
      wanted.size > found.size &&
      pending.length > 0 &&
      listed < AGENT_DEFINITION_FILE_WALK_MAX_FOLDERS
    ) {
      const batch = pending.slice(
        0,
        Math.min(
          AGENT_DEFINITION_FILE_WALK_CONCURRENCY,
          AGENT_DEFINITION_FILE_WALK_MAX_FOLDERS - listed,
        ),
      );
      pending = pending.slice(batch.length);
      listed += batch.length;
      const listings = await Promise.all(
        batch.map((folder) =>
          this.#files.list(folder === undefined ? {} : { path: folder }, request),
        ),
      );
      for (const entry of listings.flat()) {
        if (wanted.has(entry.id)) found.set(entry.id, entry.path);
        if (entry.kind === 'folder') pending.push(entry.path);
      }
    }
    return found;
  }

  /** Map each wanted path to its file id, listing each parent folder once. */
  async #filesAt(
    paths: readonly string[],
    request: RequestOptions,
  ): Promise<ReadonlyMap<string, string>> {
    const parents = [...new Set(paths.map(parentOf))];
    const listings = await Promise.all(
      parents.map((parent) =>
        this.#files
          .list(parent === '' ? {} : { path: parent }, request)
          .catch((error: unknown): readonly FileResource[] => {
            // A parent folder that does not exist is a missing file, not a failed import.
            if (error instanceof ApiProblemError && error.status === 404) return [];
            throw error;
          }),
      ),
    );
    const byPath = new Map<string, string>();
    for (const entry of listings.flat()) byPath.set(entry.path, entry.id);
    return new Map(
      paths.flatMap((path) => {
        const id = byPath.get(path);
        return id === undefined ? [] : [[path, id] as const];
      }),
    );
  }
}
