/**
 * The production {@link DemoTemplateOperations}: what `PUT /api/demo/templates/{entry}` and
 * `GET /api/demo/templates` call (internal spec, "How Try it works"). Seeding fills the template
 * workspace of one entry (`demoTemplateWorkspaceSlug(entry)`) from a seed the deployment's own
 * operator step sends, through the agents, files, skills and connectors domains, the same ones a
 * visitor's copy is read from (`template-copy.ts`):
 *
 * - The workspace is made when it is missing, with the entry's own template-owner account
 *   (`<entry>@demo-templates.invalid`, `template-owner.ts`) as its only member. A workspace that has
 *   the slug and is not the deployment's is refused, never filled.
 * - The seed's sample files and record sets are saved in it: files at their paths, record sets in
 *   the reserved folder (`template-layout.ts`), which a copy never carries as sample data. A folder
 *   the agent is granted that holds no sample file (a scratch folder it writes in) is made empty.
 * - Each declared connector is stored as the row `template-connector.ts` describes, with no address
 *   and no secret.
 * - Each skill the definition names is made through the skills domain: one the seed carries from
 *   its files, a built-in from the platform's own release. The seed carries every other skill the
 *   definition names and no skill it does not; a pinned revision is refused, since a template
 *   holds a skill's files as they are and a copy follows them.
 * - The agent is the seed's K-1 definition, created the way `aw agents import` creates one: the
 *   agent row with the definition's permissions, its file grants and connectors resolved by name in
 *   this workspace, its skills by name, and its stored policy with the rules pointed at the
 *   connectors' ids. It names no model connection and no runtime profile.
 * - The digest of the seed is saved last. The same seed again finds the same digest and changes
 *   nothing; a different seed replaces the agent, the skills, the connectors, the files and the
 *   records, so a seed that stopped half way is made again by the next.
 */
import type { AgentDefinition } from '@indx-workspace/contracts/agents';
import {
  DEMO_TEMPLATE_SLUG_PREFIX,
  demoTemplateWorkspaceSlug,
  type DemoEntrySlug,
} from '@indx-workspace/contracts/demo';
import type {
  DemoTemplateReports,
  DemoTemplateSeed,
} from '@indx-workspace/contracts/demo-operator';
import { isBuiltinSkillName } from '@indx-workspace/contracts/skills';

import type { AgentRecord, AgentStoreProvider, WorkspaceSkills } from '../../agents';
import type { ConnectorsStoreProvider } from '../../integrations';
import type { DirectoryRoot } from '../../identity';
import type { StorageService } from '../../storage-and-sharing';
import type { DemoTemplateOperations } from '../operator';
import { allCatalogRows, type Catalog, type CatalogFile } from './catalog-rows';
import { DEMO_SAMPLE_FILE_MAX_BYTES } from './limits';
import { withConnectorIdsByName } from './policy-remap';
import { RecordsTooLargeError, recordsServerCommand } from './records-server';
import { DEMO_TEMPLATE_CONNECTOR_COMMAND, templateConnectorArgs } from './template-connector';
import {
  DEMO_TEMPLATE_DIGEST_PATH,
  RECORDS_PREFIX,
  isReservedPath,
  recordSetPath,
  seedDigest,
} from './template-layout';
import { DEMO_TEMPLATE_OWNER_DOMAIN, isDeploymentTemplate } from './template-owner';

/** Why a seed is refused: the seed is wrong (`demo_seed_invalid`), or the slug is not the deployment's. */
export class DemoSeedRefusal extends Error {
  constructor(
    readonly code: 'demo_seed_invalid' | 'demo_template_not_deployment_owned',
    message: string,
  ) {
    super(message);
  }
}

/** Making template workspaces, and finding the ones that exist. */
export interface TemplateWorkspaces {
  /**
   * Make the workspace `slug` with the account `ownerEmail` as its only member, an Owner. `null`
   * where the slug is taken (a concurrent seed made it first); the caller then finds it.
   */
  make(input: {
    readonly slug: string;
    readonly name: string;
    readonly ownerEmail: string;
    readonly now: Date;
  }): Promise<string | null>;
  /** The slug of every workspace in the reserved template namespace. */
  templateSlugs(): Promise<readonly string[]>;
}

export interface DemoTemplateSeedDependencies {
  readonly workspaceIdForSlug: (slug: string) => Promise<string | null>;
  readonly workspaces: TemplateWorkspaces;
  readonly directory: Pick<DirectoryRoot, 'forWorkspace'>;
  readonly agents: AgentStoreProvider;
  readonly connectors: Pick<ConnectorsStoreProvider, 'forWorkspace'>;
  readonly catalogs: (workspaceId: string) => Promise<Pick<Catalog, 'list' | 'get'>>;
  readonly storage: Pick<StorageService, 'open' | 'save' | 'remove' | 'createFolder'>;
  /** The skills domain; `null` where the deployment keeps no skills, and a seed naming one fails. */
  readonly skills: WorkspaceSkills | null;
}

/** The template-owner account of an entry. */
export const templateOwnerEmail = (entry: DemoEntrySlug): string =>
  `${entry}@${DEMO_TEMPLATE_OWNER_DOMAIN}`;

const invalid = (message: string): DemoSeedRefusal =>
  new DemoSeedRefusal('demo_seed_invalid', message);

/** The refusals of a seed that does not hold together, found before anything is written. */
export function checkSeed(seed: DemoTemplateSeed): void {
  const { definition } = seed;
  checkSkills(seed);
  const declared = new Map(seed.connectors.map((connector) => [connector.name, connector]));
  if (declared.size !== seed.connectors.length) throw invalid('a connector is declared twice');
  for (const name of definition.resources.connectors) {
    if (!declared.has(name))
      throw invalid(`the definition names the connector ${name}, which the seed does not declare`);
  }
  const paths = seed.files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) throw invalid('a sample file is listed twice');
  for (const path of paths) {
    if (isReservedPath(path)) throw invalid(`the sample file ${path} is in the reserved folder`);
  }
  const sets = new Set<string>();
  for (const set of seed.records) {
    const connector = declared.get(set.connector);
    if (connector === undefined)
      throw invalid(
        `a record set names the connector ${set.connector}, which the seed does not declare`,
      );
    const unread = set.tools.find((tool) => !connector.reads.includes(tool));
    if (unread !== undefined)
      throw invalid(
        `a record set of ${set.connector} names ${unread}, which is not one of its read tools`,
      );
    const key = recordSetPath(set);
    if (sets.has(key)) throw invalid(`the record set ${key} is listed twice`);
    sets.add(key);
  }
  // A connector's records ride in one stand-in's arguments, so they must fit it.
  for (const connector of seed.connectors) {
    try {
      recordsServerCommand({
        reads: connector.reads,
        writes: connector.writes,
        sets: seed.records.filter((set) => set.connector === connector.name),
      });
    } catch (error) {
      if (error instanceof RecordsTooLargeError) {
        throw invalid(
          `the records of the connector ${connector.name} are too large for one stand-in`,
        );
      }
      throw error;
    }
  }
}

/**
 * The skills of a seed hold together: the definition names each skill once, the seed carries every
 * one it names that is not a built-in and none it does not name, and no revision is pinned.
 */
function checkSkills(seed: DemoTemplateSeed): void {
  const named = seed.definition.resources.skills;
  if (new Set(named).size !== named.length) throw invalid('the definition names a skill twice');
  if (Object.keys(seed.definition.resources.skillRevisions ?? {}).length > 0) {
    throw invalid('the definition pins a skill revision, which a template does not keep');
  }
  const carried = seed.skills.map((skill) => skill.name);
  if (new Set(carried).size !== carried.length) throw invalid('a skill is carried twice');
  for (const name of named) {
    if (!isBuiltinSkillName(name) && !carried.includes(name))
      throw invalid(`the definition names the skill ${name}, which the seed does not carry`);
  }
  for (const name of carried) {
    if (!named.includes(name))
      throw invalid(`the seed carries the skill ${name}, which the definition does not name`);
  }
}

const isActive = (agent: AgentRecord): boolean => agent.archivedAt === undefined;

export function createDemoTemplateOperations(
  deps: DemoTemplateSeedDependencies,
): DemoTemplateOperations {
  const allRows = (workspaceId: string) => allCatalogRows(deps.catalogs, workspaceId);

  async function textOf(workspaceId: string, row: CatalogFile): Promise<string | null> {
    const opened = await deps.storage.open({ workspaceId }, row);
    return opened === null ? null : await new Response(opened.body).text();
  }

  /** The workspace of `entry`, made when it is missing; refused when it is not the deployment's. */
  async function templateWorkspace(entry: DemoEntrySlug, now: Date): Promise<string> {
    const slug = demoTemplateWorkspaceSlug(entry);
    let id = await deps.workspaceIdForSlug(slug);
    if (id === null) {
      id = await deps.workspaces.make({
        slug,
        name: `Agent Store demo template: ${entry}`,
        ownerEmail: templateOwnerEmail(entry),
        now,
      });
      id ??= await deps.workspaceIdForSlug(slug);
    }
    if (id === null) throw new Error(`the demo template workspace ${slug} was not made`);
    if (!(await isDeploymentTemplate(deps.directory, id))) {
      throw new DemoSeedRefusal(
        'demo_template_not_deployment_owned',
        `the workspace ${slug} exists and is not a demo template of this deployment`,
      );
    }
    return id;
  }

  /** The digest of the seed the template was last filled from, or `null`. */
  async function storedDigest(workspaceId: string): Promise<string | null> {
    const row = await (await deps.catalogs(workspaceId)).get(DEMO_TEMPLATE_DIGEST_PATH);
    return row === null || row.kind !== 'file'
      ? null
      : ((await textOf(workspaceId, row))?.trim() ?? null);
  }

  /** Delete the template's skills, through the skills domain. */
  async function wipeSkills(workspaceId: string): Promise<void> {
    const skills = deps.skills;
    if (skills === null) return;
    for (const skill of await skills.list(workspaceId)) {
      const removed = await skills.remove(workspaceId, skill.name);
      if (removed.kind !== 'removed' && removed.kind !== 'not-found') {
        throw new Error(`the demo template skill ${skill.name} was not removed: ${removed.kind}`);
      }
    }
  }

  /** Delete what a seed made: the agents, the skills, the connectors, and every file and folder. */
  async function wipe(workspaceId: string): Promise<void> {
    const agents = deps.agents.forWorkspace(workspaceId);
    for (const agent of await agents.list()) await agents.delete(agent.id);
    // The agents first, so no skill is still assigned.
    await wipeSkills(workspaceId);
    const connectors = deps.connectors.forWorkspace(workspaceId);
    for (const connector of await connectors.list()) await connectors.delete(connector.id);
    // The deepest rows first, so a folder is emptied before it is removed.
    const rows = [...(await allRows(workspaceId))].sort((a, b) => b.path.length - a.path.length);
    for (const row of rows) {
      const removed = await deps.storage.remove({ workspaceId }, 'files', row.path, {
        recursive: row.kind === 'folder',
      });
      if (!removed.ok && removed.code !== 'not_found') {
        throw new Error(`the demo template file ${row.path} was not removed: ${removed.code}`);
      }
    }
  }

  async function save(
    owner: { workspaceId: string; principalId: string; userId: string | null },
    path: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const saved = await deps.storage.save(owner, {
      area: 'files',
      path,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
      maxBytes: DEMO_SAMPLE_FILE_MAX_BYTES,
      contentType,
      replace: false,
    });
    if (!saved.ok) throw new Error(`the demo template file ${path} was not saved: ${saved.code}`);
  }

  /** The template's skills, through the skills domain: the ids of the definition's, in its order. */
  async function makeSkills(
    seed: DemoTemplateSeed,
    workspaceId: string,
    owner: { principalId: string; userId: string | null },
  ): Promise<readonly string[]> {
    const named = seed.definition.resources.skills;
    if (named.length === 0) return [];
    const skills = deps.skills;
    if (skills === null) {
      throw new Error('the demo seed names skills and this deployment keeps none');
    }
    await skills.installBuiltins(workspaceId, owner, named.filter(isBuiltinSkillName));
    for (const skill of seed.skills) {
      const made = await skills.create(workspaceId, owner, {
        name: skill.name,
        files: skill.files.map((file) => ({
          path: file.path,
          bytes: new Uint8Array(Buffer.from(file.base64, 'base64')),
        })),
      });
      if (made.kind === 'refused') {
        throw invalid(`the skill ${skill.name} was refused: ${made.code}`);
      }
    }
    const byName = new Map((await skills.list(workspaceId)).map((skill) => [skill.name, skill.id]));
    return named.map((name) => {
      const id = byName.get(name);
      if (id === undefined) throw new Error(`the demo template skill ${name} was not made`);
      return id;
    });
  }

  async function createAgent(
    definition: AgentDefinition,
    workspaceId: string,
    owner: { principalId: string; userId: string | null },
    connectorIds: ReadonlyMap<string, string>,
    skillIds: readonly string[],
  ): Promise<void> {
    const catalog = await deps.catalogs(workspaceId);
    const files: { fileId: string; access: 'read' | 'read-write' }[] = [];
    for (const grant of definition.resources.files) {
      const row = await catalog.get(grant.path);
      if (row === null)
        throw invalid(`the definition grants ${grant.path}, which is not in the template`);
      files.push({ fileId: row.id, access: grant.access });
    }
    const store = deps.agents.forWorkspace(workspaceId);
    const { agent } = definition;
    const made = await store.createWithAssignments(
      {
        name: agent.name,
        instructions: agent.instructions,
        // A model connection and a runtime profile belong to a workspace: the copy makes its own.
        modelConnectionId: null,
        model: null,
        permissions: agent.permissions,
      },
      owner,
      {
        files,
        skillIds: [...skillIds],
        connectorIds: definition.resources.connectors.flatMap(
          (name) => connectorIds.get(name) ?? [],
        ),
      },
    );
    if (made.kind !== 'created') {
      throw invalid(`the demo agent ${agent.name} was not created: ${made.kind}`);
    }
    // A compiled policy stays compiled: it follows the permissions, as a copy's would.
    if (definition.policySource === 'stored') {
      const stored = await store.replacePolicy(
        made.agent.id,
        withConnectorIdsByName(definition.policy, connectorIds),
      );
      if (stored.kind !== 'updated')
        throw new Error(`the demo agent ${agent.name} lost its policy`);
    }
  }

  async function fill(workspaceId: string, seed: DemoTemplateSeed, digest: string): Promise<void> {
    const members = await deps.directory.forWorkspace(workspaceId).listMemberships();
    const member = members[0];
    if (member === undefined) throw new Error('the demo template has no owner');
    const owner = { principalId: member.principalId, userId: member.userId };
    const ctx = { workspaceId, ...owner };
    for (const file of seed.files) {
      await save(ctx, file.path, Buffer.from(file.base64, 'base64'), 'application/octet-stream');
    }
    for (const set of seed.records) {
      await save(
        ctx,
        recordSetPath(set),
        new TextEncoder().encode(JSON.stringify(set)),
        'application/json',
      );
    }
    // A grant no sample file is under is a scratch folder the agent writes in: it is made empty.
    for (const grant of seed.definition.resources.files) {
      if (
        seed.files.some(
          (file) => file.path === grant.path || file.path.startsWith(`${grant.path}/`),
        )
      ) {
        continue;
      }
      const made = await deps.storage.createFolder(ctx, grant.path);
      if (!made.ok && made.code !== 'name_conflict') {
        throw new Error(`the demo template folder ${grant.path} was not made: ${made.code}`);
      }
    }
    const connectors = deps.connectors.forWorkspace(workspaceId);
    const connectorIds = new Map<string, string>();
    for (const connector of seed.connectors) {
      const made = await connectors.create(
        {
          name: connector.name,
          transport: 'stdio',
          command: DEMO_TEMPLATE_CONNECTOR_COMMAND,
          args: templateConnectorArgs(connector.reads, connector.writes),
          url: null,
          authType: 'none',
          credential: null,
        },
        owner,
      );
      if (made.kind !== 'created')
        throw new Error(`the demo connector ${connector.name} was not made: ${made.kind}`);
      connectorIds.set(connector.name, made.server.id);
    }
    const skillIds = await makeSkills(seed, workspaceId, owner);
    await createAgent(seed.definition, workspaceId, owner, connectorIds, skillIds);
    // The digest last: a seed that stopped before it is made again by the next.
    await save(ctx, DEMO_TEMPLATE_DIGEST_PATH, new TextEncoder().encode(digest), 'text/plain');
  }

  return {
    async seed({ entry, seed, now }) {
      checkSeed(seed);
      const digest = seedDigest(seed);
      const workspaceId = await templateWorkspace(entry, now);
      const agents = (await deps.agents.forWorkspace(workspaceId).list()).filter(isActive);
      if (agents.length > 0 && (await storedDigest(workspaceId)) === digest) {
        return { changed: false };
      }
      await wipe(workspaceId);
      await fill(workspaceId, seed, digest);
      return { changed: true };
    },

    async report(): Promise<DemoTemplateReports> {
      const templates: DemoTemplateReports['templates'][number][] = [];
      for (const slug of [...(await deps.workspaces.templateSlugs())].sort()) {
        const entry = slug.slice(DEMO_TEMPLATE_SLUG_PREFIX.length);
        const workspaceId = await deps.workspaceIdForSlug(slug);
        if (workspaceId === null || !(await isDeploymentTemplate(deps.directory, workspaceId)))
          continue;
        const agent = (await deps.agents.forWorkspace(workspaceId).list()).find(isActive);
        const rows = await allRows(workspaceId);
        const sets = rows.filter(
          (row) => row.kind === 'file' && row.path.startsWith(RECORDS_PREFIX),
        );
        templates.push({
          entry,
          agent: agent?.name ?? null,
          files: rows.filter((row) => row.kind === 'file' && !isReservedPath(row.path)).length,
          recordSets: sets.length,
        });
      }
      return { templates };
    },
  };
}
