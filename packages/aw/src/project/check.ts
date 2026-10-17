import {
  AGENT_VERSION_SUMMARY_MAX_LENGTH,
  AgentVersionSummarySchema,
  type AgentVersionBody,
  type AgentVersionDraftInput,
} from '@indx-workspace/contracts/agent-versions';
import type { AgentResource } from '@indx-workspace/contracts/agents';
import type { EngineId } from '@indx-workspace/contracts/engines';
import { ApiProblemError, type AgentWorkspaceClient } from '@indx-workspace/sdk';

import { UsageError, type CliIo } from '../io.js';
import { bundleCodeTool, type ToolBundle } from '../tools/bundle.js';
import {
  loadProject,
  type LoadedCodeTool,
  type LoadedTool,
  type LoaderFeatures,
  type ProjectLoad,
} from './load.js';
import { localProblem, problemsFromError, type ProjectProblem } from './problems.js';
import { missingSkillProblems, nearestName, readProjectSkills } from './skills.js';

/** What `checkProject` and `pushProject` take. */
export interface ProjectRunOptions {
  readonly client: AgentWorkspaceClient;
  /** The project's directory, absolute. */
  readonly root: string;
  readonly io: CliIo;
  readonly signal: AbortSignal;
  /** The summary of every version; `aw push: <agent file>` when left out. */
  readonly summary?: string | undefined;
  /** `process.features`, or what a test puts in its place. */
  readonly features?: LoaderFeatures | undefined;
  readonly timeoutMs?: number | undefined;
  /** The project file's `engine`, for an agent that names none (C12). */
  readonly defaultEngine?: EngineId | undefined;
  /** Variables the loader child must not see: the project's secret names (SD17). */
  readonly withheld?: readonly string[] | undefined;
  /**
   * What to do with the project's catalog tools before the agents are dry-run (C15): `aw check`
   * dry-runs their connectors, `aw dev` applies them. Left out, tools are not touched here (`aw
   * push` applies them in its `skillStep` instead, once every local check has passed). Its
   * problems join the check's. It also gets the project's code tools (`defineTool()`, ADR-0115),
   * which `aw dev` serves from its tool host.
   */
  readonly toolStep?:
    | ((
        tools: readonly LoadedTool[],
        codeTools: readonly LoadedCodeTool[],
      ) => Promise<readonly ProjectProblem[]>)
    | undefined;
  /**
   * Runs once the project has loaded with no local problem (a bad file, a refused `skills/`
   * folder), before any agent is dry-run: the server refuses a version naming a skill the
   * workspace does not have yet, so `aw push` and `aw dev` upload `skills/` here. Its problems
   * join the check's.
   */
  readonly skillStep?: (() => Promise<readonly ProjectProblem[]>) | undefined;
  /**
   * Without `--yes` (`aw check`): the `skills/` folders a push would create. A dry run refused only
   * because it names these is accepted, as it would be once they exist.
   */
  readonly pendingSkills?: ReadonlySet<string> | undefined;
  /**
   * Without `--yes` (`aw push`): the catalog tools a push would create, whose connectors the
   * workspace lacks. Accepted like {@link pendingSkills}, for a refusal naming only them.
   */
  readonly pendingConnectors?: ReadonlySet<string> | undefined;
  /**
   * `aw check` and `aw push` (issue #790, ADR-0118 TS1): the project's code tools are bundled, each
   * agent's body pins the digests of the tools it lists, and this runs once with no local problem,
   * after `skillStep`, to upload the bundles the workspace lacks. Left out (`aw dev`, TS7), nothing
   * is bundled and no body carries `toolBundles`. Its problems join the check's.
   */
  readonly bundleStep?:
    | ((bundles: readonly ToolBundle[]) => Promise<{
        readonly problems: readonly ProjectProblem[];
        readonly reports: readonly BundleReport[];
      }>)
    | undefined;
  /**
   * Asked once `toolStep` has run: `true` leaves the code tools unbundled, as without `bundleStep`.
   * Set when the workspace is `aw dev`'s runtime, whose tool host serves them from source (TS7,
   * BH061-001).
   */
  readonly skipBundles?: (() => boolean) | undefined;
}

/** What one code tool's bundle needs: nothing (`unchanged`) or an upload, done or, without `--yes`, not. */
export interface BundleReport {
  readonly file: string;
  readonly tool: string;
  readonly digest: string;
  readonly bytes: number;
  readonly action: 'upload' | 'unchanged';
  /** Whether the bundle was uploaded by this run. */
  readonly saved: boolean;
}

/** One agent the server accepted in a dry run. */
export interface CheckedAgent {
  readonly file: string;
  readonly name: string;
  /** The agent of that name in the workspace, or `null` when the push would create it. */
  readonly agentId: string | null;
  /** That agent's `updatedAt`, or `null` with `agentId`. */
  readonly updatedAt: string | null;
  /** The number the version would be saved as. */
  readonly number: number;
  readonly body: AgentVersionBody;
  readonly surfaceFiles: readonly string[];
  readonly draft: AgentVersionDraftInput;
}

/** One tool of the project that loaded and passed its dry run, for `aw check` to report. */
export interface CheckedTool {
  readonly file: string;
  readonly name: string;
  readonly kind: 'openapi' | 'postgres' | 'code';
}

export interface CheckReport {
  /** No problem, locally or on the server. */
  readonly ok: boolean;
  readonly problems: readonly ProjectProblem[];
  readonly agents: readonly CheckedAgent[];
  /** The secret names the project's agents' tools reference, from the load. */
  readonly secrets: readonly string[];
  /** The tools with no problem against their file: catalog tools, then code tools. */
  readonly tools: readonly CheckedTool[];
  /** The code tools' bundles, with `bundleStep`: what each needs and whether it was uploaded. */
  readonly bundles: readonly BundleReport[];
}

/** A given summary must be one the server accepts; a bad one is a usage error, before any work. */
export function resolveSummary(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined;
  const parsed = AgentVersionSummarySchema.safeParse(summary);
  if (!parsed.success) {
    throw new UsageError(
      `--summary ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  return parsed.data;
}

/** A line or paragraph separator; legal in a file name, refused in a summary. */
const SEPARATORS = /[\p{Zl}\p{Zp}]/gu;

/**
 * `aw push: <file>`, the summary of a version when `--summary` is left out, cut with `…` to the
 * contract's length on a code point boundary, so a long file name still makes a valid summary.
 */
function defaultSummary(file: string): string {
  const full = `aw push: ${file}`.replace(SEPARATORS, ' ');
  if (full.length <= AGENT_VERSION_SUMMARY_MAX_LENGTH) return full;
  let cut = '';
  for (const character of full) {
    if (cut.length + character.length > AGENT_VERSION_SUMMARY_MAX_LENGTH - 1) break;
    cut += character;
  }
  return `${cut.trimEnd()}…`;
}

/**
 * The agents in an order where every subagent the project defines comes before the agent naming it
 * (ADR-0133 D14: the server refuses a version naming a subagent it does not hold yet), ties broken
 * by agent name. A name the project does not define is the server's to answer. With a cycle no
 * order exists: the answer is the cycle's agent names, starting at its alphabetically first and
 * closing on it (`a → b → a`).
 */
export function orderBySubagents<
  Agent extends {
    readonly name: string;
    readonly body: { readonly subagents?: readonly { readonly name: string }[] | undefined };
  },
>(agents: readonly Agent[]): { readonly ordered: readonly Agent[] } | { readonly cycle: string[] } {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  const dependencies = new Map(
    agents.map((agent) => [
      agent.name,
      (agent.body.subagents ?? [])
        .map((subagent) => subagent.name)
        .filter((name) => name !== agent.name && byName.has(name)),
    ]),
  );
  const ordered: Agent[] = [];
  const pending = new Set(byName.keys());
  for (;;) {
    const next = [...pending]
      .filter((name) => (dependencies.get(name) ?? []).every((dep) => !pending.has(dep)))
      .toSorted()[0];
    if (next === undefined) break;
    pending.delete(next);
    const agent = byName.get(next);
    if (agent !== undefined) ordered.push(agent);
  }
  if (pending.size === 0) return { ordered };
  // Each agent left waits on another left one, so following that wait from any of them must come
  // back to an agent already seen: that is a cycle.
  const walk: string[] = [];
  let at: string | undefined = [...pending].toSorted()[0];
  while (at !== undefined && !walk.includes(at)) {
    walk.push(at);
    at = (dependencies.get(at) ?? []).filter((dep) => pending.has(dep)).toSorted()[0];
  }
  const loop = walk.slice(at === undefined ? 0 : walk.indexOf(at));
  const first = loop.toSorted()[0];
  const start = first === undefined ? 0 : loop.indexOf(first);
  const rotated = [...loop.slice(start), ...loop.slice(0, start)];
  return { cycle: [...rotated, ...rotated.slice(0, 1)] };
}

/**
 * Whether the server refused a version only for skills, connectors and subagents a push creates
 * first: `skill:` details in `pending.skills` (folders), `connector:` details in
 * `pending.connectors` (catalog tools), and `subagent:` details in `pending.subagents` (agents the
 * project defines and the workspace lacks).
 */
function agentWaitsOnPending(
  error: unknown,
  pending: {
    readonly skills: ReadonlySet<string> | undefined;
    readonly connectors: ReadonlySet<string> | undefined;
    readonly bundles: ReadonlySet<string>;
    /** Project agents the workspace lacks: a push creates them before the agents naming them. */
    readonly subagents: ReadonlySet<string>;
  },
): boolean {
  const isPending = (detail: string): boolean =>
    (detail.startsWith('skill:') && pending.skills?.has(detail.slice(6)) === true) ||
    (detail.startsWith('connector:') && pending.connectors?.has(detail.slice(10)) === true);
  if (error instanceof ApiProblemError && error.code === 'tool_bundle_unknown') {
    return (
      error.details.length > 0 &&
      error.details.every((detail) => pending.bundles.has(detail.replace(/^tool_bundle:/u, '')))
    );
  }
  if (error instanceof ApiProblemError && error.code === 'agent_subagent_unusable') {
    return (
      error.details.length > 0 &&
      error.details.every((detail) => pending.subagents.has(detail.replace(/^subagent:/u, '')))
    );
  }
  return (
    error instanceof ApiProblemError &&
    error.code === 'agent_definition_references_missing' &&
    error.details.length > 0 &&
    error.details.every(isPending)
  );
}

/**
 * BH061-019: one problem per agent whose `model: { connection, id }` names a connection that lists
 * its models (`GET /api/models`) but not `id`: the server saves any id, and only a run refuses it
 * (`model_unavailable`). A connection the catalogue does not list (not ready, or its provider could
 * not be read) is not judged, nor is any agent when the catalogue itself is refused: the run checks
 * the id again. Each problem is also set in `refused`, by file, so that agent is not dry-run.
 */
async function unknownModelProblems(
  client: AgentWorkspaceClient,
  agents: ProjectLoad['agents'],
  signal: AbortSignal,
  refused: Map<string, readonly ProjectProblem[]>,
): Promise<readonly ProjectProblem[]> {
  const problems: ProjectProblem[] = [];
  const named = agents.filter(
    (agent) => agent.body.definition.agent.model !== null && !refused.has(agent.file),
  );
  if (named.length === 0) return problems;
  let connections;
  let catalog;
  try {
    [connections, catalog] = await Promise.all([
      client.models.connections.list({ signal }),
      client.models.discover({ signal }),
    ]);
  } catch (error) {
    if (error instanceof ApiProblemError) return problems;
    throw error;
  }
  for (const agent of named) {
    const { model, modelConnectionName } = agent.body.definition.agent;
    const connection = connections.find((candidate) => candidate.name === modelConnectionName);
    if (model === null || connection === undefined) continue;
    const offered = catalog.models
      .filter((entry) => entry.connectionId === connection.id)
      .map((entry) => entry.providerModelId);
    if (offered.length === 0 || offered.includes(model)) continue;
    const near = nearestName(model, offered);
    const problem = localProblem(agent.file, 'model_not_found', [
      `model '${model}' is not offered by the connection '${connection.name}'` +
        (near === undefined ? '' : ` (did you mean '${near}'?)`),
    ]);
    refused.set(agent.file, [problem]);
    problems.push(problem);
  }
  return problems;
}

/** Bundle every code tool; a refusal is pushed onto `problems` and leaves that tool out. */
async function bundleProjectTools(
  root: string,
  codeTools: readonly LoadedCodeTool[],
  problems: ProjectProblem[],
): Promise<Map<string, ToolBundle>> {
  const bundles = new Map<string, ToolBundle>();
  for (const tool of codeTools) {
    const bundled = await bundleCodeTool(root, tool);
    if (bundled.ok) bundles.set(tool.name, bundled.bundle);
    else problems.push(bundled.problem);
  }
  return bundles;
}

/**
 * The code tools' bundles to pin and the step that uploads them. Under `skipBundles` (BH061-001)
 * the tools are still bundled, so a missing or broken run file is reported, but none is pinned.
 */
async function projectBundles(
  options: ProjectRunOptions,
  codeTools: readonly LoadedCodeTool[],
  problems: ProjectProblem[],
): Promise<{
  readonly step: ProjectRunOptions['bundleStep'];
  readonly bundles: ReadonlyMap<string, ToolBundle>;
}> {
  if (options.bundleStep === undefined) return { step: undefined, bundles: new Map() };
  const bundles = await bundleProjectTools(options.root, codeTools, problems);
  return options.skipBundles?.() === true
    ? { step: undefined, bundles: new Map() }
    : { step: options.bundleStep, bundles };
}

/** Upload step for the bundles, run only once every local refusal is known and none was found. */
async function runBundleStep(
  step: ProjectRunOptions['bundleStep'],
  bundles: ReadonlyMap<string, ToolBundle>,
  problems: ProjectProblem[],
): Promise<readonly BundleReport[]> {
  if (step === undefined || bundles.size === 0 || problems.length > 0) return [];
  const stepped = await step([...bundles.values()]);
  problems.push(...stepped.problems);
  return stepped.reports;
}

/**
 * The agent's body with its code tools' digests and declarations (ADR-0118 TS1, TS4, TS5), sorted
 * by tool name, recorded as `toolBundles`.
 */
function pinBundles(
  agent: { readonly body: AgentVersionBody; readonly codeTools: readonly LoadedCodeTool[] },
  bundles: ReadonlyMap<string, ToolBundle>,
): AgentVersionBody {
  const pinned = agent.codeTools
    .flatMap((tool) => {
      const bundle = bundles.get(tool.name);
      return bundle === undefined
        ? []
        : [{ tool: bundle.tool, digest: bundle.digest, ...tool.pinned }];
    })
    .toSorted((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
  return pinned.length === 0 ? agent.body : { ...agent.body, toolBundles: pinned };
}

/** The names of `agents` that `stored` lacks: what a push creates before the agents naming them. */
function namesMissingFrom(
  agents: readonly { readonly name: string }[],
  stored: readonly { readonly name: string }[],
): Set<string> {
  const have = new Set(stored.map((agent) => agent.name));
  return new Set(agents.map((agent) => agent.name).filter((name) => !have.has(name)));
}

/**
 * The load with its agents in subagent order. A project cycle is refused before any request: no
 * push order makes it work, so the load keeps no agents and no tools, and says why.
 */
function orderedByNeed(loaded: ProjectLoad): ProjectLoad {
  const ordering = orderBySubagents(loaded.agents);
  if (!('cycle' in ordering)) return { ...loaded, agents: ordering.ordered };
  const { cycle } = ordering;
  const file = loaded.agents.find((agent) => agent.name === cycle[0])?.file ?? '';
  return {
    ...loaded,
    agents: [],
    tools: [],
    codeTools: [],
    problems: [...loaded.problems, localProblem(file, 'subagent_cycle', [cycle.join(' → ')])],
  };
}

/**
 * `aw check` (issue #452): load the project, then dry-run every agent that loaded cleanly through
 * the server's save pipeline — `POST /api/agents/:id/versions {dryRun}` for an agent the workspace
 * already has (found by its exact name), `POST /api/agents {version, dryRun}` for a new one. Nothing
 * is written. Every refusal, local or remote, is a problem attributed to its file.
 */
export async function checkProject(options: ProjectRunOptions): Promise<CheckReport> {
  const summary = resolveSummary(options.summary);
  const { client, signal } = options;
  const load = orderedByNeed(await loadProject(options));
  const problems = [...load.problems];
  if (options.toolStep !== undefined && (load.tools.length > 0 || load.codeTools.length > 0)) {
    problems.push(...(await options.toolStep(load.tools, load.codeTools)));
  }
  const { step: bundleStep, bundles } = await projectBundles(options, load.codeTools, problems);
  const agents: CheckedAgent[] = [];
  const { secrets } = load;
  const failed = new Set(problems.map((problem) => problem.file));
  const tools: CheckedTool[] = [
    ...load.tools.map(({ file, definition }) => ({
      file,
      name: definition.name,
      kind: definition.kind,
    })),
    ...load.codeTools.map(({ file, name }) => ({ file, name, kind: 'code' as const })),
  ].filter((tool) => !failed.has(tool.file));
  const folders = await readProjectSkills(options.root);
  problems.push(...folders.problems);
  if (load.agents.length === 0) {
    if (options.skillStep !== undefined && problems.length === 0) {
      problems.push(...(await options.skillStep()));
    }
    return { ok: problems.length === 0, problems, agents, secrets, tools, bundles: [] };
  }

  let existing: readonly AgentResource[];
  try {
    existing = await client.agents.list({ signal });
  } catch (error) {
    for (const agent of load.agents) problems.push(...problemsFromError(error, agent.file, []));
    return { ok: false, problems, agents, secrets, tools, bundles: [] };
  }

  const known = new Set(folders.names);
  let skillListError: unknown;
  if (
    load.agents.some((agent) => agent.body.definition.resources.skills.some((n) => !known.has(n)))
  ) {
    try {
      for (const skill of await client.skills.list({ signal })) known.add(skill.name);
    } catch (error) {
      skillListError = error; // reported below instead of a false skill_not_found
    }
  }
  const refusedByAgent = new Map<string, readonly ProjectProblem[]>();
  for (const agent of load.agents) {
    const missing = missingSkillProblems(
      { file: agent.file, skills: agent.body.definition.resources.skills },
      known,
    );
    if (missing.length === 0) continue;
    const reported =
      skillListError === undefined ? missing : problemsFromError(skillListError, agent.file, []);
    refusedByAgent.set(agent.file, reported);
    problems.push(...reported);
  }
  problems.push(...(await unknownModelProblems(client, load.agents, signal, refusedByAgent)));

  // Every local refusal is known: only now may `skills/` be written, so a failing check writes none.
  if (options.skillStep !== undefined && problems.length === 0) {
    problems.push(...(await options.skillStep()));
  }
  const bundleReports = await runBundleStep(bundleStep, bundles, problems);
  // Without `--yes` a bundle that is not uploaded yet is pending: the dry run would refuse it.
  const pendingBundles = new Set(
    bundleReports
      .filter((report) => report.action === 'upload' && !report.saved)
      .map((report) => report.digest),
  );

  // A project agent the push creates, or saves as a leaf, is pending: it is saved before its parent.
  const pendingSubagents = new Set([
    ...namesMissingFrom(load.agents, existing),
    ...load.agents
      .filter((agent) => (agent.body.subagents ?? []).length === 0)
      .map((agent) => agent.name),
  ]);

  for (const loadedAgent of load.agents) {
    if (refusedByAgent.has(loadedAgent.file)) continue;
    const agent = { ...loadedAgent, body: pinBundles(loadedAgent, bundles) };
    const draft: AgentVersionDraftInput = {
      body: agent.body,
      summary: summary ?? defaultSummary(agent.file),
      via: 'aw-push',
    };
    const match = existing.find((candidate) => candidate.name === agent.name);
    const agentId = match?.id ?? null;
    try {
      const answer =
        agentId === null
          ? await client.agents.create({ version: draft, dryRun: true }, { signal })
          : await client.agents.versions.check(agentId, draft, { signal });
      agents.push({
        ...agent,
        agentId,
        updatedAt: match?.updatedAt ?? null,
        number: answer.number,
        draft,
      });
    } catch (error) {
      if (
        agentWaitsOnPending(error, {
          skills: options.pendingSkills,
          connectors: options.pendingConnectors,
          bundles: pendingBundles,
          subagents: pendingSubagents,
        })
      ) {
        // The server's answer to the rest of the body is not known; plan the next number.
        const versions =
          agentId === null ? undefined : await client.agents.versions.list(agentId, { signal });
        const number = Math.max(0, ...(versions?.items.map((item) => item.number) ?? [])) + 1;
        agents.push({ ...agent, agentId, updatedAt: match?.updatedAt ?? null, number, draft });
        continue;
      }
      problems.push(...problemsFromError(error, agent.file, agent.surfaceFiles));
    }
  }
  return { ok: problems.length === 0, problems, agents, secrets, tools, bundles: bundleReports };
}
