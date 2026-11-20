/**
 * The production {@link DemoTemplates}: it reads a catalog entry's template workspace
 * (`demoTemplateWorkspaceSlug(entry)`) and writes the visitor's demo workspace, in both cases
 * through the agents, files, skills and connectors domains (their store providers), never around
 * them.
 *
 * What a template workspace is: the deployment fills it with the entry's demo agent and the sample
 * data that agent reads (`demo.seed`), and owns it through a system account (`template-owner.ts`;
 * a workspace anyone else made with the slug is not a template). The agent is the one thing in it,
 * so every active agent in the template is the entry's, and each is copied.
 *
 * What a copy is, for each template agent:
 *
 * - The agent row, as the template has it, with no model connection named on it (a connection
 *   belongs to the template's workspace) and the guest as its owner. It runs on the visitor's
 *   workspace's own `default` connection, below, and the deployment's default model.
 * - The sample files it reads: the files and folders it is assigned, with their bytes, at the same
 *   paths. Nothing else of the template workspace is read.
 * - Its skills: each skill it is assigned, made in the visitor's workspace through the skills
 *   domain with the template's files under the same name (a built-in is installed from the
 *   platform's own release, which is what the template holds), and assigned to the copy. Only the
 *   template's skills are read, so only what the deployment seeded runs; they go with the workspace.
 * - Its connectors, by {@link planDemoConnector}: a reader is left out, a tool that could send or
 *   write outside is a stand-in that answers `DEMO_SEND_RESULT` (`fake-send-server.ts`). No
 *   address, no secret and no connector row of the template reaches the copy. An MCP stand-in
 *   offers the tools the template's rules name on that connector. A connector the seed declared
 *   (`template-connector.ts`) whose read tools have sample records in the template becomes a
 *   records stand-in (`records-server.ts`): its read tools answer with those records, its write
 *   tools with `DEMO_SEND_RESULT`; with no records its reads are left out.
 * - A sandbox with no internet: ONE runtime profile of the visitor's workspace on the deployment's
 *   runtime driver, with the network policy `none`, attached to the agent. Never the template's,
 *   never an open one; a run of the copy has no network but the gateway (`proof/no-internet.test.ts`).
 * - A Test Runtime pass of that driver for the visitor's workspace, which a run needs and the guest
 *   cannot make (`DemoSandbox.verifyRuntime`): this deployment's current pass, carried with its own
 *   expiry, or a Test Runtime run for the workspace when the instance holds none.
 * - A model: a connection named `default`, provider `anthropic`, holding the deployment's demo API
 *   key (`AW_DEMO_ANTHROPIC_API_KEY`), made through the models domain, which seals it. The guest
 *   has no grant on connections, secrets or runtimes, so the key is never read by the visitor, and
 *   it goes with the workspace. Without a key there is no connection and a run start is refused.
 * - Its policy, its tool rules pointed at the stand-ins (`policy-remap.ts`, so a write the template
 *   makes wait for approval still waits), with the per-run caps clamped to `limits` (never wider than the template's own),
 *   its skill allowlist as the template has it, and no unrestricted network. The policy is applied
 *   every time, to an agent found from an earlier copy too, so a copy that stopped before it was
 *   capped is capped by the next.
 * - A grant for the guest to run it.
 *
 * Copying is safe to repeat: files already at their path are kept, a skill or an agent whose name
 * the workspace holds is found and not made again, and the grant is set to the guest alone.
 *
 * The real-model verification workspace gets the same copy (`copyIntoVerification`,
 * `verification.ts`), made for its Owner where a demo has its guest, so R1 and the daily test run
 * exactly what a visitor's demo runs.
 */
import type { AgentPolicy } from '@indx-workspace/contracts/agents';
import { demoTemplateWorkspaceSlug, type DemoEntrySlug } from '@indx-workspace/contracts/demo';

import {
  compiledPolicyFor,
  type AgentGrantStoreProvider,
  type AgentRecord,
  type AgentResourceStoreProvider,
  type AgentStoreProvider,
  type WorkspaceSkills,
} from '../../agents';
import type { ConnectorsStoreProvider, ModelsStoreProvider } from '../../integrations';
import type { DirectoryRoot } from '../../identity';
import type { RuntimeProfileStoreProvider } from '../../execution';
import type { StorageService } from '../../storage-and-sharing';
import { allCatalogRows, type Catalog } from './catalog-rows';
import { withStandInConnectorIds } from './policy-remap';
import type { DemoRunLimits, DemoSandbox, DemoTemplates } from './ports';
import { standInConnectors } from './template-copy-connectors';
import { copyFiles } from './template-copy-files';
import {
  DEMO_MODEL_CONNECTION_NAME,
  DEMO_RUNTIME_PROFILE_NAME,
  ensureModelConnection,
  ensureSandboxProfile,
} from './template-copy-sandbox';
import { copySkills, templateSkillNames } from './template-copy-skills';
import type { TemplateSource, Visitor } from './template-copy-types';
import { isDeploymentTemplate } from './template-owner';

export { DEMO_MODEL_CONNECTION_NAME, DEMO_RUNTIME_PROFILE_NAME };

export interface DemoTemplateDependencies {
  /** The id of the workspace with this slug, or `null`: the one lookup by slug the copy needs. */
  readonly workspaceIdForSlug: (slug: string) => Promise<string | null>;
  /** The guest's membership principal in the demo workspace is read from here. */
  readonly directory: Pick<DirectoryRoot, 'membershipsForUser' | 'forWorkspace'>;
  readonly agents: AgentStoreProvider;
  readonly resources: AgentResourceStoreProvider;
  readonly grants: AgentGrantStoreProvider;
  readonly connectors: Pick<ConnectorsStoreProvider, 'forWorkspace'>;
  /** The file catalog of a workspace: rows of files and folders, for reading and for paths. */
  readonly catalogs: (workspaceId: string) => Promise<Pick<Catalog, 'list' | 'get'>>;
  /** The files service: bytes are opened in the template and saved in the demo workspace. */
  readonly storage: Pick<StorageService, 'open' | 'save' | 'createFolder'>;
  /** The models domain: the visitor workspace's `default` connection is made through it. */
  readonly models: Pick<ModelsStoreProvider, 'forWorkspace'>;
  /**
   * The skills domain: a template agent's skills are read in the template and made in the visitor's
   * workspace through it. `null` where the deployment keeps no skills; a template agent that has a
   * skill then cannot be copied, and the copy fails rather than run the agent without it.
   */
  readonly skills: WorkspaceSkills | null;
  /** The runtimes domain: the visitor workspace's sandbox profile is made through it. */
  readonly runtimeProfiles: Pick<RuntimeProfileStoreProvider, 'forWorkspace'>;
  /** What the demo runs on: the deployment's runtime driver and Anthropic API key. */
  readonly sandbox: DemoSandbox;
}

/** The smaller of two caps, where `null` is no cap of that side. */
function narrower(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

const isActive = (agent: AgentRecord): boolean => agent.archivedAt === undefined;

/** What one agent's copy is made in: the template it is read from, who it is for, how it is capped. */
interface AgentCopyContext {
  readonly template: TemplateSource;
  readonly visitor: Visitor;
  readonly limits: DemoRunLimits;
  readonly profileId: string | null;
}

const NO_ASSIGNMENTS = { files: [], skillIds: [], connectorIds: [], storageGrants: [] };

/**
 * The template agent's policy: the stored one, or the one compiled from its permissions and the
 * skills it is assigned (`skillNames`), as a run of the template would compile it.
 */
const templatePolicy = (agent: AgentRecord, skillNames: readonly string[]): AgentPolicy =>
  agent.policy ?? compiledPolicyFor(agent.permissions, skillNames);

/**
 * The copy's policy: the template's, its rules on the stand-ins, its skill allowlist, caps no
 * wider than `limits`.
 */
function copyPolicy(
  agent: AgentRecord,
  skillNames: readonly string[],
  limits: DemoRunLimits,
  standIns: ReadonlyMap<string, string>,
): AgentPolicy {
  const base = withStandInConnectorIds(templatePolicy(agent, skillNames), standIns);
  return {
    ...base,
    limits: {
      maxTurns: narrower(base.limits.maxTurns, limits.maxTurns),
      maxBudgetUsd: narrower(base.limits.maxBudgetUsd, limits.maxBudgetUsd),
    },
  };
}

/**
 * The template workspace of `entry`, or `null`. A workspace with the slug that the deployment did
 * not make (one a person created) is no template (`template-owner.ts`).
 */
async function templateWorkspaceId(
  deps: DemoTemplateDependencies,
  entry: DemoEntrySlug,
): Promise<string | null> {
  const id = await deps.workspaceIdForSlug(demoTemplateWorkspaceSlug(entry));
  return id !== null && (await isDeploymentTemplate(deps.directory, id)) ? id : null;
}

async function activeAgents(
  deps: DemoTemplateDependencies,
  workspaceId: string,
): Promise<readonly AgentRecord[]> {
  return (await deps.agents.forWorkspace(workspaceId).list()).filter(isActive);
}

/**
 * The membership principal of whom the copy is made for: the guest of a demo workspace, or the
 * Owner of a verification workspace. A copy is never made for a member with any other role.
 */
async function visitorOf(
  deps: DemoTemplateDependencies,
  workspaceId: string,
  userId: string,
  role: 'guest' | 'owner',
): Promise<Visitor> {
  const held = await deps.directory.membershipsForUser(userId);
  const membership = held.find((m) => m.workspaceId === workspaceId && m.role === role);
  if (membership === undefined) {
    throw new Error(`the workspace has no ${role} membership for the copy's recipient`);
  }
  return { workspaceId, principalId: membership.principalId, userId };
}

/** The visitor's agent that a template agent is copied into, with the policy it is to have. */
interface AgentToCap {
  readonly agent: AgentRecord;
  readonly agentId: string;
  readonly policy: AgentPolicy;
}

/**
 * Put the copy's policy and sandbox on the visitor's agent. Idempotent: the same policy again
 * changes nothing, and an agent whose first copy stopped between its creation and its caps (or
 * before the sandbox was attached) gets them here.
 */
async function capAgent(
  deps: DemoTemplateDependencies,
  { agent, agentId, policy }: AgentToCap,
  ctx: AgentCopyContext,
): Promise<string> {
  const store = deps.agents.forWorkspace(ctx.visitor.workspaceId);
  const replaced = await store.replacePolicy(agentId, policy);
  if (replaced.kind !== 'updated') throw new Error(`the demo agent ${agent.name} lost its policy`);
  if (ctx.profileId !== null) {
    const attached = await store.update(agentId, { runtimeProfileId: ctx.profileId });
    if (attached.kind !== 'updated') {
      throw new Error(`the demo agent ${agent.name} has no sandbox profile: ${attached.kind}`);
    }
  }
  return agentId;
}

/** The resources of a template agent, as made in the visitor's workspace. */
interface CopiedResources {
  readonly files: Awaited<ReturnType<typeof copyFiles>>;
  readonly skillIds: readonly string[];
  readonly connectorIds: readonly string[];
}

/** Make the visitor's agent from the template's, with its copied resources. */
async function createAgentCopy(
  deps: DemoTemplateDependencies,
  agent: AgentRecord,
  resources: CopiedResources,
  ctx: AgentCopyContext,
) {
  const { profileId, visitor } = ctx;
  return deps.agents.forWorkspace(visitor.workspaceId).createWithAssignments(
    {
      name: agent.name,
      instructions: agent.instructions,
      modelConnectionId: null,
      model: null,
      ...(profileId === null ? {} : { runtimeProfileId: profileId }),
      // A demo sandbox has no internet, whatever the template agent was built to allow.
      permissions: { ...agent.permissions, unrestrictedNetwork: false },
    },
    { principalId: visitor.principalId, userId: visitor.userId },
    {
      files: resources.files,
      skillIds: [...resources.skillIds],
      connectorIds: [...resources.connectorIds],
    },
  );
}

async function copyAgent(
  deps: DemoTemplateDependencies,
  agent: AgentRecord,
  ctx: AgentCopyContext,
): Promise<string> {
  const { template, visitor, limits } = ctx;
  const store = deps.agents.forWorkspace(visitor.workspaceId);
  const assigned =
    (await deps.resources.forWorkspace(template.workspaceId).get(agent.id)) ?? NO_ASSIGNMENTS;
  const skillNames = await templateSkillNames(deps.skills, template.workspaceId, assigned.skillIds);
  // Found by name when an earlier copy made them, so this is safe to repeat.
  const standIns = await standInConnectors(
    deps,
    { assignedIds: assigned.connectorIds, template, policy: templatePolicy(agent, skillNames) },
    visitor,
  );
  const capped = (agentId: string) =>
    capAgent(
      deps,
      { agent, agentId, policy: copyPolicy(agent, skillNames, limits, standIns) },
      ctx,
    );
  const findByName = async () =>
    (await store.list()).find((candidate) => candidate.name === agent.name);
  const present = await findByName();
  if (present !== undefined) return capped(present.id);
  const made = await createAgentCopy(
    deps,
    agent,
    {
      files: await copyFiles(deps, assigned.files, template, visitor),
      skillIds: await copySkills(deps.skills, skillNames, template.workspaceId, visitor),
      connectorIds: [...standIns.values()],
    },
    ctx,
  );
  if (made.kind === 'name-conflict') {
    // Another copy of the same entry, running at the same time, made it first.
    const raced = await findByName();
    if (raced !== undefined) return capped(raced.id);
  }
  if (made.kind !== 'created') {
    throw new Error(`the demo agent ${agent.name} was not copied: ${made.kind}`);
  }
  return capped(made.agent.id);
}

/** The sandbox and the model first: an agent is never copied without the profile it runs in. */
async function prepareVisitorWorkspace(
  deps: DemoTemplateDependencies,
  visitor: Visitor,
): Promise<string | null> {
  const profileId = await ensureSandboxProfile(deps, visitor);
  if (profileId !== null && deps.sandbox.runtimeDriver !== null) {
    await deps.sandbox.verifyRuntime(visitor.workspaceId, deps.sandbox.runtimeDriver);
  }
  await ensureModelConnection(deps, visitor);
  return profileId;
}

async function grantVisitorTheAgent(
  deps: DemoTemplateDependencies,
  agent: AgentRecord,
  agentId: string,
  visitor: Visitor,
): Promise<void> {
  const granted = await deps.grants
    .forWorkspace(visitor.workspaceId)
    .replacePrincipalIds(agentId, [visitor.principalId]);
  if (granted.kind !== 'updated') {
    throw new Error(`the recipient was not granted the demo agent ${agent.name}: ${granted.kind}`);
  }
}

/** Copy `entry`'s template for `visitor`: one sequence for a visitor's demo and a verification. */
async function copyFor(
  deps: DemoTemplateDependencies,
  entry: DemoEntrySlug,
  visitor: Visitor,
  limits: DemoRunLimits,
): Promise<void> {
  const templateId = await templateWorkspaceId(deps, entry);
  if (templateId === null) throw new Error(`no demo template for ${entry}`);
  const template = {
    workspaceId: templateId,
    rows: await allCatalogRows(deps.catalogs, templateId),
  };
  const profileId = await prepareVisitorWorkspace(deps, visitor);
  for (const agent of await activeAgents(deps, templateId)) {
    const agentId = await copyAgent(deps, agent, { template, visitor, limits, profileId });
    await grantVisitorTheAgent(deps, agent, agentId, visitor);
  }
}

export function createDemoTemplates(deps: DemoTemplateDependencies): DemoTemplates {
  return {
    exists: async (entry) => {
      const workspaceId = await templateWorkspaceId(deps, entry);
      return workspaceId !== null && (await activeAgents(deps, workspaceId)).length > 0;
    },

    async copyInto({ entry, workspaceId, guestUserId, limits }) {
      await copyFor(deps, entry, await visitorOf(deps, workspaceId, guestUserId, 'guest'), limits);
    },

    async copyIntoVerification({ entry, workspaceId, ownerUserId, limits }) {
      await copyFor(deps, entry, await visitorOf(deps, workspaceId, ownerUserId, 'owner'), limits);
    },
  };
}
