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
import type { AgentPolicy, AgentResourceAssignments } from '@indx-workspace/contracts/agents';
import { isBuiltinSkillName } from '@indx-workspace/contracts/skills';
import { demoTemplateWorkspaceSlug, type DemoEntrySlug } from '@indx-workspace/contracts/demo';
import {
  DemoSampleRecordsSchema,
  type DemoSampleRecords,
} from '@indx-workspace/contracts/demo-operator';

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
import { allCatalogRows, type Catalog, type CatalogFile } from './catalog-rows';
import { fakeSendServerCommand } from './fake-send-server';
import { DEMO_SAMPLE_FILE_MAX_BYTES } from './limits';
import { planDemoConnector } from './outside-tools';
import { toolsNamedOn, withStandInConnectorIds } from './policy-remap';
import type { DemoRunLimits, DemoSandbox, DemoTemplates } from './ports';
import { recordsServerCommand } from './records-server';
import { isReservedPath, recordsFolderOf } from './template-layout';
import { isDeploymentTemplate } from './template-owner';

/** The name of the demo workspace's runtime profile. */
export const DEMO_RUNTIME_PROFILE_NAME = 'demo-sandbox';
/** The model connection every run without one of its own resolves to (contract C7). */
export const DEMO_MODEL_CONNECTION_NAME = 'default';

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

/** Who the copy is made for, in the demo workspace. */
interface Visitor {
  readonly workspaceId: string;
  readonly principalId: string;
  readonly userId: string;
}

export function createDemoTemplates(deps: DemoTemplateDependencies): DemoTemplates {
  /**
   * The template workspace of `entry`, or `null`. A workspace with the slug that the deployment did
   * not make (one a person created) is no template (`template-owner.ts`).
   */
  async function templateWorkspaceId(entry: DemoEntrySlug): Promise<string | null> {
    const id = await deps.workspaceIdForSlug(demoTemplateWorkspaceSlug(entry));
    return id !== null && (await isDeploymentTemplate(deps.directory, id)) ? id : null;
  }

  async function activeAgents(workspaceId: string): Promise<readonly AgentRecord[]> {
    return (await deps.agents.forWorkspace(workspaceId).list()).filter(isActive);
  }

  const allRows = (workspaceId: string) => allCatalogRows(deps.catalogs, workspaceId);

  /**
   * The membership principal of whom the copy is made for: the guest of a demo workspace, or the
   * Owner of a verification workspace. A copy is never made for a member with any other role.
   */
  async function visitorOf(
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

  /** The record sets the template keeps for `connector`, as the seed stored them. */
  async function recordSetsOf(
    template: { readonly workspaceId: string; readonly rows: readonly CatalogFile[] },
    connector: string,
  ): Promise<readonly DemoSampleRecords[]> {
    const folder = `${recordsFolderOf(connector)}/`;
    const sets: DemoSampleRecords[] = [];
    for (const row of template.rows) {
      if (row.kind !== 'file' || !row.path.startsWith(folder)) continue;
      const opened = await deps.storage.open({ workspaceId: template.workspaceId }, row);
      if (opened === null) continue;
      const parsed = DemoSampleRecordsSchema.safeParse(
        JSON.parse(await new Response(opened.body).text()),
      );
      if (!parsed.success)
        throw new Error(`the demo template's record set ${row.path} is not valid`);
      sets.push(parsed.data);
    }
    return sets;
  }

  /**
   * The visitor workspace's one sandbox profile: on the deployment's driver, network policy `none`,
   * no allowed domain. Found by name when an earlier copy made it, and set back to this definition
   * if it is not (a profile that is not `none` is never left to a demo). `null` without a driver,
   * or on a driver that cannot enforce `none`.
   */
  async function ensureSandboxProfile(visitor: Visitor): Promise<string | null> {
    const { runtimeDriver } = deps.sandbox;
    if (runtimeDriver === null) return null;
    if (!(await deps.sandbox.enforcesNoNetwork(runtimeDriver))) return null;
    const store = deps.runtimeProfiles.forWorkspace(visitor.workspaceId);
    const definition = {
      name: DEMO_RUNTIME_PROFILE_NAME,
      driver: runtimeDriver,
      runtimeConnectionId: null,
      cpu: null,
      memoryMb: null,
      diskMb: null,
      networkPolicy: 'none' as const,
      allowedDomains: null,
      filesystem: 'read-write' as const,
      persistPaths: null,
      timeoutSeconds: null,
      idleTimeoutSeconds: null,
      driverConfig: null,
    };
    const find = async () =>
      (await store.list()).find((profile) => profile.name === DEMO_RUNTIME_PROFILE_NAME);
    const present = (await find()) ?? null;
    if (present !== null) {
      const same =
        present.driver === definition.driver &&
        present.networkPolicy === 'none' &&
        present.allowedDomains === null;
      if (!same) {
        const updated = await store.update(present.id, definition);
        if (updated.kind !== 'updated') throw new Error('the demo sandbox profile was not reset');
      }
      return present.id;
    }
    const made = await store.create(definition);
    if (made.kind === 'created') return made.profile.id;
    // A name taken by a copy running at the same time is that copy's profile.
    const raced = await find();
    if (raced === undefined) throw new Error(`the demo sandbox profile was not made: ${made.kind}`);
    return raced.id;
  }

  /**
   * The visitor workspace's `default` model connection holding the demo key, made through the models
   * domain (which seals the key; nothing here keeps it). `true` when the workspace has one.
   */
  async function ensureModelConnection(visitor: Visitor): Promise<boolean> {
    const { anthropicApiKey } = deps.sandbox;
    if (anthropicApiKey === null) return false;
    const store = deps.models.forWorkspace(visitor.workspaceId);
    const has = async () =>
      (await store.list()).some((connection) => connection.name === DEMO_MODEL_CONNECTION_NAME);
    if (await has()) return true;
    const made = await store.create({
      name: DEMO_MODEL_CONNECTION_NAME,
      provider: 'anthropic',
      apiKey: anthropicApiKey,
      config: {},
    });
    // A name taken by a copy running at the same time is that copy's connection.
    if (made.kind !== 'created' && !(await has())) {
      throw new Error(`the demo model connection was not made: ${made.kind}`);
    }
    return true;
  }

  /** Copy one template row (a file, or a folder with the files under it) into the visitor's workspace. */
  async function copyRow(
    row: CatalogFile,
    template: { readonly workspaceId: string; readonly rows: readonly CatalogFile[] },
    visitor: Visitor,
  ): Promise<void> {
    const owner = {
      workspaceId: visitor.workspaceId,
      principalId: visitor.principalId,
      userId: visitor.userId,
    };
    let files: readonly CatalogFile[] = [row];
    if (row.kind === 'folder') {
      const made = await deps.storage.createFolder(owner, row.path);
      if (!made.ok && made.code !== 'name_conflict') {
        throw new Error(`demo template folder ${row.path} was not copied: ${made.code}`);
      }
      files = template.rows.filter(
        (candidate) => candidate.kind === 'file' && candidate.path.startsWith(`${row.path}/`),
      );
    }
    for (const file of files) {
      const opened = await deps.storage.open({ workspaceId: template.workspaceId }, file);
      if (opened === null) continue;
      const saved = await deps.storage.save(owner, {
        area: 'files',
        path: file.path,
        body: opened.body,
        maxBytes: DEMO_SAMPLE_FILE_MAX_BYTES,
        contentType: file.contentType,
        replace: false,
      });
      // A file already at its path is a copy made before; any other refusal is a defect.
      if (!saved.ok && saved.code !== 'path_taken') {
        throw new Error(`demo template file ${file.path} was not copied: ${saved.code}`);
      }
    }
  }

  /** The visitor's file assignments for the template agent's: the same paths, the visitor's rows. */
  async function copyFiles(
    assigned: AgentResourceAssignments['files'],
    template: { readonly workspaceId: string; readonly rows: readonly CatalogFile[] },
    visitor: Visitor,
  ): Promise<AgentResourceAssignments['files']> {
    const copied: { fileId: string; access: 'read' | 'read-write' }[] = [];
    const visitorCatalog = await deps.catalogs(visitor.workspaceId);
    for (const grant of assigned) {
      const row = template.rows.find((candidate) => candidate.id === grant.fileId);
      // The deployment's own folder (records, digest) is never sample data a copy carries.
      if (row === undefined || isReservedPath(row.path)) continue;
      await copyRow(row, template, visitor);
      const made = await visitorCatalog.get(row.path);
      if (made !== null) copied.push({ fileId: made.id, access: grant.access });
    }
    return copied;
  }

  /**
   * The visitor workspace's connectors for the template agent's, by {@link planDemoConnector}: each
   * template connector id that has a stand-in, mapped to the stand-in's id, in assignment order.
   */
  async function standInConnectors(
    assignedIds: readonly string[],
    template: { readonly workspaceId: string; readonly rows: readonly CatalogFile[] },
    policy: AgentPolicy,
    visitor: Visitor,
  ): Promise<ReadonlyMap<string, string>> {
    const source = deps.connectors.forWorkspace(template.workspaceId);
    const target = deps.connectors.forWorkspace(visitor.workspaceId);
    const present = await target.list();
    const ids = new Map<string, string>();
    for (const id of assignedIds) {
      const connector = await source.get(id);
      if (connector === null) continue;
      const plan = planDemoConnector(connector);
      if (plan.kind === 'omit') continue;
      const existing = present.find((candidate) => candidate.name === plan.name);
      if (existing !== undefined) {
        ids.set(id, existing.id);
        continue;
      }
      // The reads of a declared connector answer from its records; with none they are left out.
      const sets = plan.reads.length > 0 ? await recordSetsOf(template, plan.name) : [];
      const reads = plan.reads.filter((tool) => sets.some((set) => set.tools.includes(tool)));
      // A connector the seed declared that only reads, with no records to read, is left out.
      if (reads.length === 0 && plan.reads.length > 0 && plan.tools.length === 0) continue;
      const tools = plan.tools.length > 0 ? plan.tools : toolsNamedOn(policy, id);
      const { command, args } =
        reads.length > 0
          ? recordsServerCommand({ reads, writes: plan.tools, sets })
          : fakeSendServerCommand(tools);
      const made = await target.create(
        {
          name: plan.name,
          transport: 'stdio',
          command,
          args,
          url: null,
          authType: 'none',
          credential: null,
        },
        { principalId: visitor.principalId, userId: visitor.userId },
      );
      if (made.kind === 'created') {
        ids.set(id, made.server.id);
        continue;
      }
      // A name taken by a copy running at the same time is that copy's stand-in.
      const raced = (await target.list()).find((candidate) => candidate.name === plan.name);
      if (raced === undefined) {
        throw new Error(`the demo stand-in for ${plan.name} was not made: ${made.kind}`);
      }
      ids.set(id, raced.id);
    }
    return ids;
  }

  /**
   * The template agent's policy: the stored one, or the one compiled from its permissions and the
   * skills it is assigned (`skillNames`), as a run of the template would compile it.
   */
  const templatePolicy = (agent: AgentRecord, skillNames: readonly string[]): AgentPolicy =>
    agent.policy ?? compiledPolicyFor(agent.permissions, skillNames);

  /**
   * The names of the template agent's skills, in assignment order. A template agent with a skill on
   * a deployment that keeps no skills is not copied: its copy would run without it.
   */
  async function templateSkillNames(
    templateId: string,
    skillIds: readonly string[],
  ): Promise<readonly string[]> {
    if (skillIds.length === 0) return [];
    if (deps.skills === null) {
      throw new Error('the demo template agent has skills and this deployment keeps none');
    }
    const byId = new Map((await deps.skills.list(templateId)).map((skill) => [skill.id, skill]));
    return skillIds.map((id) => {
      const skill = byId.get(id);
      if (skill === undefined) throw new Error(`the demo template has no skill ${id}`);
      return skill.name;
    });
  }

  /**
   * The visitor workspace's skills for the template agent's `names`, through the skills domain: a
   * built-in installed from the platform's release, any other made from the template's files under
   * the same name. Found by name when an earlier copy made it. The ids, in the order of `names`.
   */
  async function copySkills(
    names: readonly string[],
    templateId: string,
    visitor: Visitor,
  ): Promise<readonly string[]> {
    const skills = deps.skills;
    if (names.length === 0 || skills === null) return [];
    const owner = { principalId: visitor.principalId, userId: visitor.userId };
    await skills.installBuiltins(visitor.workspaceId, owner, names.filter(isBuiltinSkillName));
    const ids: string[] = [];
    for (const name of names) {
      const present = (await skills.list(visitor.workspaceId)).find((skill) => skill.name === name);
      if (present !== undefined) {
        ids.push(present.id);
        continue;
      }
      if (isBuiltinSkillName(name)) throw new Error(`the built-in skill ${name} was not installed`);
      const files = await skills.files(templateId, name);
      if (files === null) throw new Error(`the demo template's skill ${name} has no files`);
      const made = await skills.create(visitor.workspaceId, owner, { name, files });
      if (made.kind === 'refused') {
        throw new Error(`the demo skill ${name} was not copied: ${made.code}`);
      }
      ids.push(made.id);
    }
    return ids;
  }

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

  async function copyAgent(
    agent: AgentRecord,
    template: { readonly workspaceId: string; readonly rows: readonly CatalogFile[] },
    visitor: Visitor,
    limits: DemoRunLimits,
    profileId: string | null,
  ): Promise<string> {
    const store = deps.agents.forWorkspace(visitor.workspaceId);
    const assigned = (await deps.resources.forWorkspace(template.workspaceId).get(agent.id)) ?? {
      files: [],
      skillIds: [],
      connectorIds: [],
      storageGrants: [],
    };
    const skillNames = await templateSkillNames(template.workspaceId, assigned.skillIds);
    // Found by name when an earlier copy made them, so this is safe to repeat.
    const standIns = await standInConnectors(
      assigned.connectorIds,
      template,
      templatePolicy(agent, skillNames),
      visitor,
    );
    const capped = async (agentId: string): Promise<string> => {
      // Idempotent: the same policy again changes nothing, and an agent whose first copy stopped
      // between its creation and its caps gets them here.
      const policy = await store.replacePolicy(
        agentId,
        copyPolicy(agent, skillNames, limits, standIns),
      );
      if (policy.kind !== 'updated')
        throw new Error(`the demo agent ${agent.name} lost its policy`);
      // The sandbox too: an agent whose first copy stopped before it was attached gets it here.
      if (profileId !== null) {
        const attached = await store.update(agentId, { runtimeProfileId: profileId });
        if (attached.kind !== 'updated') {
          throw new Error(`the demo agent ${agent.name} has no sandbox profile: ${attached.kind}`);
        }
      }
      return agentId;
    };
    const present = (await store.list()).find((candidate) => candidate.name === agent.name);
    if (present !== undefined) return capped(present.id);
    const files = await copyFiles(assigned.files, template, visitor);
    const skillIds = await copySkills(skillNames, template.workspaceId, visitor);
    const connectorIds = [...standIns.values()];
    const made = await store.createWithAssignments(
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
      { files, skillIds: [...skillIds], connectorIds },
    );
    if (made.kind === 'name-conflict') {
      // Another copy of the same entry, running at the same time, made it first.
      const raced = (await store.list()).find((candidate) => candidate.name === agent.name);
      if (raced !== undefined) return capped(raced.id);
    }
    if (made.kind !== 'created') {
      throw new Error(`the demo agent ${agent.name} was not copied: ${made.kind}`);
    }
    return capped(made.agent.id);
  }

  /** Copy `entry`'s template for `visitor`: one sequence for a visitor's demo and a verification. */
  async function copyFor(
    entry: DemoEntrySlug,
    visitor: Visitor,
    limits: DemoRunLimits,
  ): Promise<void> {
    const templateId = await templateWorkspaceId(entry);
    if (templateId === null) throw new Error(`no demo template for ${entry}`);
    const template = { workspaceId: templateId, rows: await allRows(templateId) };
    // The sandbox and the model first: an agent is never copied without the profile it runs in.
    const profileId = await ensureSandboxProfile(visitor);
    await ensureModelConnection(visitor);
    for (const agent of await activeAgents(templateId)) {
      const agentId = await copyAgent(agent, template, visitor, limits, profileId);
      const granted = await deps.grants
        .forWorkspace(visitor.workspaceId)
        .replacePrincipalIds(agentId, [visitor.principalId]);
      if (granted.kind !== 'updated') {
        throw new Error(
          `the recipient was not granted the demo agent ${agent.name}: ${granted.kind}`,
        );
      }
    }
  }

  return {
    exists: async (entry) => {
      const workspaceId = await templateWorkspaceId(entry);
      return workspaceId !== null && (await activeAgents(workspaceId)).length > 0;
    },

    async copyInto({ entry, workspaceId, guestUserId, limits }) {
      await copyFor(entry, await visitorOf(workspaceId, guestUserId, 'guest'), limits);
    },

    async copyIntoVerification({ entry, workspaceId, ownerUserId, limits }) {
      await copyFor(entry, await visitorOf(workspaceId, ownerUserId, 'owner'), limits);
    },
  };
}
