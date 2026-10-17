import {
  AgentVersionBodySchema,
  type AgentVersionListResponse,
} from '@indx-workspace/contracts/agent-versions';

import type { ProjectDocument } from '@indx-workspace/contracts/project-file';
import { AW_DEV_TOOLS_CONNECTOR } from '@indx-workspace/contracts/tool-connectors';
import { ApiProblemError } from '@indx-workspace/sdk';

import type { CliIo } from '../io.js';
import { applyProjectTools, type AppliedTool } from '../local-runtime/project-resources.js';
import {
  checkProject,
  type BundleReport,
  type CheckedAgent,
  type CheckedTool,
  type ProjectRunOptions,
} from './check.js';
import { deepEqual, diff, type Change } from './diff.js';
import type { LoadedTool } from './load.js';
import { NO_SKILL_SYNC, syncProjectSkills, type SkillSync } from './skills.js';
import { createToolHost, planToolHost } from './tool-host.js';
import { checkTools } from './tools.js';
import {
  editedInUiProblem,
  problemsFromError,
  type EditedInUi,
  type ProjectProblem,
} from './problems.js';

/**
 * What a push does for one agent:
 *
 * - `create` — the workspace has no agent of that name: create it from its first version, which
 *   also points `local` at it;
 * - `version` — save a new version and point `local` at it;
 * - `point` — the newest version already holds this body: point `local` at it, saving nothing.
 *   When `local` already names it but the agent was edited after the pointer moved (an edit made
 *   outside versions, unversioned until V-2), the pointer is set to the same version again, which
 *   materialises it over that edit;
 * - `none` — the newest version holds this body, `local` runs it and the agent has not been
 *   edited since.
 *
 * With `onEdited: 'refuse'` (`aw dev`), an existing agent edited outside `aw` — its row is no
 * longer the version `local` names, or it has no `local` pointer at all — gets no action: it is
 * refused with an `edited_in_ui` problem before any write, whether its body changed or not.
 */
type PushAction = 'create' | 'version' | 'point' | 'none';

/** What a plan says about one agent, before and after `--yes`. */
interface PlanFields {
  readonly file: string;
  readonly name: string;
  /** The version `local` runs after the push (or would, without `--yes`). */
  readonly version: number;
  /** The `local` pointer before and after; `from` is `null` when there was none. */
  readonly local: { readonly from: number | null; readonly to: number };
  /**
   * The body against the newest version, or — for an agent with no version yet — the definition
   * against the agent as exported. Empty for `point` and `none`.
   */
  readonly changes: readonly Change[];
  /**
   * The names of the agent's surfaces in the version `local` runs after the push (or would,
   * without `--yes`), in body order. `aw dev` prints a page, try and widget line for each (C5).
   */
  readonly surfaces: readonly string[];
}

/**
 * What a push would do for one agent, read without writing: what `aw check` prints and what
 * `aw push` applies. Only `create` has no agent id yet.
 */
export type AgentPlan = PlanFields &
  (
    | { readonly agentId: null; readonly action: 'create' }
    | { readonly agentId: string; readonly action: Exclude<PushAction, 'create'> }
  );

export interface PushedAgent extends PlanFields {
  /** `null` for an agent a push without `--yes` would create. */
  readonly agentId: string | null;
  readonly action: PushAction;
  /** Whether this agent was written: `--yes` was given and its action wrote something. */
  readonly saved: boolean;
}

/** `aw check`'s report: the problems, and the plan of every agent that has none. */
export interface PlanReport {
  /** No problem, locally, on the server, or while planning. */
  readonly ok: boolean;
  readonly problems: readonly ProjectProblem[];
  readonly agents: readonly AgentPlan[];
  /** The code tools' bundles a push would upload, or finds already stored (issue #790). */
  readonly bundles: readonly BundleReport[];
  /** Each `skills/` folder's plan, and the workspace skills with no folder. */
  readonly skills: SkillSync;
  /** The project's tools that loaded and passed, for the lines `aw check` prints. */
  readonly tools: readonly CheckedTool[];
}

export interface PushReport {
  /**
   * Whether every agent was saved: `--yes` was given and nothing was refused. A push is not atomic
   * across agents: when a later agent is refused, the earlier ones (each `saved: true` in
   * `agents`) were already written.
   */
  readonly saved: boolean;
  readonly problems: readonly ProjectProblem[];
  readonly agents: readonly PushedAgent[];
  /** The `skills/` folders created or updated before the agents were saved. */
  readonly skills: SkillSync;
  /** The catalog tools' connectors, created or updated (or, without `--yes`, to be) before the agents. */
  readonly tools: readonly AppliedTool[];
  /** The code tools' bundles, uploaded (or, without `--yes`, to be) before the agents (issue #790). */
  readonly bundles: readonly BundleReport[];
  /** The secret names the project's agents' tools reference: `aw dev` withholds them (SD17). */
  readonly secrets: readonly string[];
}

export interface PushOptions extends ProjectRunOptions {
  /** Write. Without it, a push sends only reads and dry runs. */
  readonly yes: boolean;
  /**
   * What to do with an existing agent edited outside `aw` (in the UI, or made there with no
   * `local` pointer). `'overwrite'`, the default, is `aw push`: the file replaces the edit.
   * `'refuse'` is `aw dev` (SD11/C21, ADR-0101): the agent is refused with an `edited_in_ui`
   * problem and nothing is written for it, while the other agents still sync.
   */
  readonly onEdited?: 'overwrite' | 'refuse';
  /** The project file, for the names its `connectors` hold: a tool may not take one (SD1). */
  readonly project?: ProjectDocument | undefined;
}

/** One agent's plan, and how it was edited outside `aw` (`null` when it was not). */
interface Planned {
  readonly plan: AgentPlan;
  readonly edited: EditedInUi | null;
}

/** A refusal of one agent made on this machine, before any write, carrying its problem. */
class AgentRefusedError extends Error {
  readonly problem: ProjectProblem;

  constructor(problem: ProjectProblem) {
    super(`${problem.file}: ${problem.code}`);
    this.name = 'AgentRefusedError';
    this.problem = problem;
  }
}

function newestOf(
  listing: AgentVersionListResponse,
): AgentVersionListResponse['items'][number] | undefined {
  let newest: AgentVersionListResponse['items'][number] | undefined;
  for (const item of listing.items) {
    if (newest === undefined || item.number > newest.number) newest = item;
  }
  return newest;
}

/** Both bodies through the schema, so the comparison does not depend on how either was written. */
function sameBody(left: unknown, right: unknown): boolean {
  const a = AgentVersionBodySchema.safeParse(left);
  const b = AgentVersionBodySchema.safeParse(right);
  return a.success && b.success && deepEqual(a.data, b.data);
}

/** The surfaces the pushed body carries, by name, in body order. */
function surfaceNames(agent: CheckedAgent): readonly string[] {
  return agent.body.surfaces.map((surface) => surface.name);
}

/**
 * How an existing agent was edited outside `aw`, or `null`: it has no `local` pointer (made in the
 * UI or through the API), or its row is no longer the version the pointer names. Setting a pointer
 * writes the row from that version; a later edit outside versions (the UI's `PATCH`, `PUT /policy`
 * or `PUT /resources`) clears `materialised` (issue #613).
 */
function editedOutsideAw(
  agent: CheckedAgent,
  pointer: { readonly number: number; readonly updatedAt: string } | undefined,
  materialised: number | null,
): EditedInUi | null {
  if (pointer === undefined) return { name: agent.name, pointer: null };
  if (agent.updatedAt === null || materialised === pointer.number) return null;
  return {
    name: agent.name,
    agentUpdatedAt: agent.updatedAt,
    pointer: { number: pointer.number, updatedAt: pointer.updatedAt },
  };
}

async function planExisting(
  agent: CheckedAgent,
  agentId: string,
  options: ProjectRunOptions,
  refuse: boolean,
): Promise<Planned> {
  const { client, signal } = options;
  const listing = await client.agents.versions.list(agentId, { signal });
  const newest = newestOf(listing);
  const pointer = listing.pointers.find((candidate) => candidate.environment === 'local');
  const from = pointer?.number ?? null;
  const edited = editedOutsideAw(agent, pointer, listing.materialised);
  // Refuse before any export or diff: those reads are wasted, and a failing one would hide the hint.
  if (refuse && edited !== null) throw new AgentRefusedError(editedInUiProblem(agent.file, edited));
  const report = { file: agent.file, name: agent.name, surfaces: surfaceNames(agent), agentId };
  if (newest !== undefined && sameBody(newest.body, agent.body)) {
    const to = newest.number;
    // Only an edit after `local` moved makes setting a pointer that already names `to` worthwhile.
    const editedAfterPointer = edited !== null && edited.pointer !== null;
    const action = from === to && !editedAfterPointer ? 'none' : 'point';
    return { plan: { ...report, action, version: to, local: { from, to }, changes: [] }, edited };
  }
  // Both sides through the schema, so only a real difference is a change.
  const changes =
    newest === undefined
      ? [
          ...diff(
            await client.agents.export(agentId, { signal }),
            agent.body.definition,
            'definition',
          ),
          ...diff([], agent.body.surfaces, 'surfaces'),
        ]
      : diff(AgentVersionBodySchema.parse(newest.body), agent.body);
  return {
    plan: {
      ...report,
      action: 'version',
      version: agent.number,
      local: { from, to: agent.number },
      changes,
    },
    edited,
  };
}

/**
 * Issue #790: for each bundle, ask the workspace whether it holds that digest and, with `yes`,
 * upload only the ones it does not (content addressing makes a repeat a no-op). A refusal is a
 * problem of the file that declares the tool.
 */
function uploadBundles(options: {
  readonly client: ProjectRunOptions['client'];
  readonly signal: AbortSignal;
  readonly yes: boolean;
}): NonNullable<ProjectRunOptions['bundleStep']> {
  const { client, signal, yes } = options;
  return async (bundles) => {
    const problems: ProjectProblem[] = [];
    const reports: BundleReport[] = [];
    for (const { file, tool, digest, bytes } of bundles) {
      try {
        const stored = await client.toolBundles.get(digest, { signal }).then(
          () => true,
          (error: unknown) => {
            if (error instanceof ApiProblemError && error.code === 'tool_bundle_not_found') {
              return false;
            }
            throw error;
          },
        );
        const upload = !stored && yes;
        if (upload) {
          await client.toolBundles.upload(
            { contentBase64: Buffer.from(bytes).toString('base64') },
            { signal },
          );
        }
        reports.push({
          file,
          tool,
          digest,
          bytes: bytes.byteLength,
          action: stored ? 'unchanged' : 'upload',
          saved: upload,
        });
      } catch (error) {
        problems.push(...problemsFromError(error, file, []));
      }
    }
    return { problems, reports };
  };
}

/**
 * What a push would do for one checked agent, sending only reads: the one comparison of the
 * project's body with the newest version and the `local` pointer that `aw check` and `aw push`
 * share, so the two can never disagree (issue #559).
 */
async function planAgent(
  agent: CheckedAgent,
  options: ProjectRunOptions,
  refuse = false,
): Promise<Planned> {
  if (agent.agentId !== null) return planExisting(agent, agent.agentId, options, refuse);
  return {
    plan: {
      file: agent.file,
      name: agent.name,
      surfaces: surfaceNames(agent),
      agentId: null,
      action: 'create',
      version: agent.number,
      local: { from: null, to: agent.number },
      changes: diff(undefined, agent.body),
    },
    edited: null,
  };
}

/**
 * Plan one agent, then — with `yes` — make the writes its action calls for. With
 * `onEdited: 'refuse'`, an agent edited outside `aw` is refused before any write.
 */
async function pushAgent(agent: CheckedAgent, options: PushOptions): Promise<PushedAgent> {
  const { plan } = await planAgent(agent, options, (options.onEdited ?? 'overwrite') === 'refuse');
  if (!options.yes) return { ...plan, saved: false };
  const { client, signal } = options;
  switch (plan.action) {
    case 'create': {
      const created = await client.agents.create({ version: agent.draft }, { signal });
      const to = created.version.number;
      return {
        ...plan,
        agentId: created.agent.id,
        version: to,
        local: { from: null, to },
        saved: true,
      };
    }
    case 'version': {
      const { agentId } = plan;
      const created = await client.agents.versions.create(agentId, agent.draft, { signal });
      await client.agents.pointers.set(
        agentId,
        { environment: 'local', version: created.number },
        { signal },
      );
      return {
        ...plan,
        version: created.number,
        local: { from: plan.local.from, to: created.number },
        saved: true,
      };
    }
    case 'point': {
      const { agentId } = plan;
      await client.agents.pointers.set(
        agentId,
        { environment: 'local', version: plan.version },
        { signal },
      );
      return { ...plan, saved: true };
    }
    case 'none':
      return { ...plan, saved: false };
    default: {
      const unreachable: never = plan;
      return unreachable;
    }
  }
}

/**
 * Run `step` for each checked agent in turn, attributing a refusal to that agent's files and going
 * on with the next one.
 */
async function eachAgent<T>(
  agents: readonly CheckedAgent[],
  step: (agent: CheckedAgent) => Promise<T>,
): Promise<{ readonly problems: ProjectProblem[]; readonly results: T[] }> {
  const problems: ProjectProblem[] = [];
  const results: T[] = [];
  for (const agent of agents) {
    try {
      results.push(await step(agent));
    } catch (error) {
      if (error instanceof AgentRefusedError) problems.push(error.problem);
      else problems.push(...problemsFromError(error, agent.file, agent.surfaceFiles));
    }
  }
  return { problems, results };
}

/**
 * `aw check` (issue #452, #559): check the project, then plan every agent the server accepted with
 * {@link planAgent} — the same comparison `aw push` makes. Sends only reads and dry runs. Problems
 * from the check and from planning are reported together with the agents that passed both. The
 * project's tools are dry-run with {@link checkTools} unless `toolStep` says otherwise (C15).
 */
export async function planProject(options: ProjectRunOptions): Promise<PlanReport> {
  const { client } = options;
  // A skills/ folder the workspace lacks is created by a push, so an agent naming it is not refused.
  const { skills, problems: skillProblems } = await syncProjectSkills({ ...options, yes: false });
  const pendingSkills = new Set(
    skills.skills.filter((skill) => skill.action === 'create').map((skill) => skill.name),
  );
  const pendingConnectors = new Set<string>();
  let devHost = false;
  const check = await checkProject({
    ...options,
    pendingSkills,
    pendingConnectors,
    skipBundles: () => devHost,
    bundleStep:
      options.toolStep === undefined
        ? uploadBundles({ client, signal: options.signal, yes: false })
        : undefined,
    toolStep:
      options.toolStep ??
      (async (tools, codeTools) => {
        const host = await planToolHost({ client, signal: options.signal }, codeTools);
        devHost = host.dev;
        if (host.create) pendingConnectors.add(AW_DEV_TOOLS_CONNECTOR);
        return [
          ...host.problems,
          ...(tools.length === 0
            ? []
            : await checkTools(
                { client, root: options.root, io: options.io, signal: options.signal },
                tools,
              )),
        ];
      }),
  });
  const planned = await eachAgent(
    check.agents,
    async (agent) => (await planAgent(agent, options)).plan,
  );
  const problems = [...check.problems, ...planned.problems, ...skillProblems];
  return {
    ok: problems.length === 0,
    problems,
    agents: planned.results,
    bundles: check.bundles,
    skills,
    tools: check.tools,
  };
}

/**
 * `aw push` (issue #452), and what `aw dev` reuses with `yes: true`: check the project first —
 * any problem and nothing is written — then, per agent, plan one {@link PushAction} with
 * {@link planAgent}. Without `yes` only reads and dry runs are sent; with it, a version is saved
 * through the `aw-push` path and `local` is pointed at it, or at the newest version when that
 * already holds the same body. `aw push` overwrites an agent edited outside `aw`; `aw dev` passes
 * `onEdited: 'refuse'`, which reports it as an `edited_in_ui` problem and writes nothing for it.
 *
 * Without a `toolStep` (`aw push`), the project's catalog tools are dry-run as `aw check` does and,
 * once every local check has passed, their connectors are created or updated with
 * {@link applyProjectTools} — the call `aw dev` makes — right after `skills/`, so the agents that
 * name them pass the server's dry run. Code tools are bundled (issue #790): each digest is pinned in
 * its agent's body, and with `yes` a bundle the workspace lacks is uploaded, once, in the same place.
 */
export async function pushProject(options: PushOptions): Promise<PushReport> {
  // The `skills/` folders go up after the local checks and before the server's dry runs, which
  // refuse a version naming a skill the workspace lacks. Without `--yes` this only plans.
  let skills = NO_SKILL_SYNC;
  let tools: readonly AppliedTool[] = [];
  // Without `--yes` nothing is uploaded, so a folder or tool the push would create is pending, as in `aw check`.
  const pendingSkills = new Set<string>();
  const pendingConnectors = new Set<string>();
  const ownTools = options.toolStep === undefined;
  let catalogTools: readonly LoadedTool[] = [];
  // The dry run and the apply say the same notice (an unset secret); each notice is printed once.
  const printed = new Set<string>();
  const io: CliIo = {
    ...options.io,
    stderr: (text) => {
      if (!text.startsWith('notice: ')) return options.io.stderr(text);
      if (printed.has(text)) return;
      printed.add(text);
      options.io.stderr(text);
    },
  };
  const { client, root, signal } = options;
  // The code tools' file, when the deployment lacks `aw-dev-tools` and this push makes it.
  let toolHostFile: string | null = null;
  // The workspace is `aw dev`'s runtime: its tool host serves the code tools, so none is bundled.
  let devHost = false;
  const toolStep: ProjectRunOptions['toolStep'] = ownTools
    ? async (loaded, codeTools) => {
        catalogTools = loaded;
        const host = await planToolHost({ client, signal }, codeTools);
        devHost = host.dev;
        // Made after the dry runs, so a deployment without a tool sandbox is refused before it is.
        if (host.create) {
          toolHostFile = codeTools[0]?.file ?? null;
          pendingConnectors.add(AW_DEV_TOOLS_CONNECTOR);
        }
        return [
          ...host.problems,
          ...(loaded.length === 0 ? [] : await checkTools({ client, root, io, signal }, loaded)),
        ];
      }
    : options.toolStep;
  const check = await checkProject({
    ...options,
    pendingSkills,
    pendingConnectors,
    skipBundles: () => devHost,
    bundleStep: ownTools ? uploadBundles({ client, signal, yes: options.yes }) : undefined,
    toolStep,
    skillStep: async () => {
      const synced = await syncProjectSkills(options);
      skills = synced.skills;
      if (!options.yes) {
        for (const skill of skills.skills)
          if (skill.action === 'create') pendingSkills.add(skill.name);
      }
      if (!ownTools || catalogTools.length === 0 || synced.problems.length > 0) {
        return synced.problems;
      }
      const applied = await applyProjectTools(
        { client, io, root, project: options.project, signal, yes: options.yes },
        catalogTools,
      );
      tools = applied.tools;
      if (!options.yes) {
        for (const tool of tools) if (tool.action === 'create') pendingConnectors.add(tool.name);
      }
      return applied.problems;
    },
  });
  const { secrets } = check;
  if (!check.ok) {
    return {
      saved: false,
      problems: check.problems,
      agents: [],
      skills,
      tools,
      bundles: check.bundles,
      secrets,
    };
  }
  const hostTool: readonly AppliedTool[] =
    toolHostFile === null
      ? []
      : [{ file: toolHostFile, name: AW_DEV_TOOLS_CONNECTOR, action: 'create' }];
  if (toolHostFile !== null && options.yes) {
    const refused = await createToolHost({ client, signal }, toolHostFile);
    if (refused.length > 0) {
      return {
        saved: false,
        problems: refused,
        agents: [],
        skills,
        tools,
        bundles: check.bundles,
        secrets,
      };
    }
  }
  const pushed = await eachAgent(check.agents, (agent) => pushAgent(agent, options));
  return {
    saved: options.yes && pushed.problems.length === 0,
    problems: pushed.problems,
    agents: pushed.results,
    skills,
    tools: [...tools, ...hostTool],
    bundles: check.bundles,
    secrets,
  };
}
