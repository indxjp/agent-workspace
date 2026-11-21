/**
 * Filling a template workspace from a seed (see `seed.ts`): the sample files and record sets, the
 * connectors, the skills and the agent, then the digest of the seed last.
 */
import type { AgentDefinition } from '@indx-workspace/contracts/agents';
import type { DemoTemplateSeed } from '@indx-workspace/contracts/demo-operator';
import { isBuiltinSkillName } from '@indx-workspace/contracts/skills';

import type { AgentStoreProvider, WorkspaceSkills } from '../../agents';
import type { DirectoryRoot } from '../../identity';
import type { ConnectorsStoreProvider } from '../../integrations';
import type { StorageService } from '../../storage-and-sharing';
import type { Catalog } from './catalog-rows';
import { DEMO_SAMPLE_FILE_MAX_BYTES } from './limits';
import { withConnectorIdsByName } from './policy-remap';
import { invalid } from './seed-check';
import { DEMO_TEMPLATE_CONNECTOR_COMMAND, templateConnectorArgs } from './template-connector';
import { DEMO_TEMPLATE_DIGEST_PATH, recordSetPath } from './template-layout';

export interface SeedFillDependencies {
  readonly directory: Pick<DirectoryRoot, 'forWorkspace'>;
  readonly agents: AgentStoreProvider;
  readonly connectors: Pick<ConnectorsStoreProvider, 'forWorkspace'>;
  readonly catalogs: (workspaceId: string) => Promise<Pick<Catalog, 'list' | 'get'>>;
  readonly storage: Pick<StorageService, 'open' | 'save' | 'remove' | 'createFolder'>;
  /** The skills domain; `null` where the deployment keeps no skills, and a seed naming one fails. */
  readonly skills: WorkspaceSkills | null;
}

interface TemplatePrincipal {
  readonly principalId: string;
  readonly userId: string | null;
}

/** Where a seed is being filled: the workspace and the member the rows are made as. */
interface FillTarget {
  readonly workspaceId: string;
  readonly owner: TemplatePrincipal;
}

/** The skill ids of the definition and the connector ids by name that the agent is made from. */
interface AgentLinks {
  readonly connectorIds: ReadonlyMap<string, string>;
  readonly skillIds: readonly string[];
}

const saveContext = (target: FillTarget) => ({ workspaceId: target.workspaceId, ...target.owner });

async function saveFile(
  deps: SeedFillDependencies,
  target: FillTarget,
  file: { readonly path: string; readonly body: Uint8Array; readonly contentType: string },
): Promise<void> {
  const { path, body } = file;
  const saved = await deps.storage.save(saveContext(target), {
    area: 'files',
    path,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }),
    maxBytes: DEMO_SAMPLE_FILE_MAX_BYTES,
    contentType: file.contentType,
    replace: false,
  });
  if (!saved.ok) throw new Error(`the demo template file ${path} was not saved: ${saved.code}`);
}

/** The seed's sample files at their paths, and its record sets in the reserved folder. */
async function saveSamples(
  deps: SeedFillDependencies,
  target: FillTarget,
  seed: DemoTemplateSeed,
): Promise<void> {
  for (const file of seed.files) {
    await saveFile(deps, target, {
      path: file.path,
      body: Buffer.from(file.base64, 'base64'),
      contentType: 'application/octet-stream',
    });
  }
  for (const set of seed.records) {
    await saveFile(deps, target, {
      path: recordSetPath(set),
      body: new TextEncoder().encode(JSON.stringify(set)),
      contentType: 'application/json',
    });
  }
}

/** A grant no sample file is under is a scratch folder the agent writes in: it is made empty. */
async function makeScratchFolders(
  deps: SeedFillDependencies,
  target: FillTarget,
  seed: DemoTemplateSeed,
): Promise<void> {
  for (const grant of seed.definition.resources.files) {
    const holdsSample = seed.files.some(
      (file) => file.path === grant.path || file.path.startsWith(`${grant.path}/`),
    );
    if (holdsSample) continue;
    const made = await deps.storage.createFolder(saveContext(target), grant.path);
    if (!made.ok && made.code !== 'name_conflict') {
      throw new Error(`the demo template folder ${grant.path} was not made: ${made.code}`);
    }
  }
}

/** The declared connectors, made with no address and no secret: their ids by name. */
async function makeConnectors(
  deps: SeedFillDependencies,
  target: FillTarget,
  seed: DemoTemplateSeed,
): Promise<ReadonlyMap<string, string>> {
  const connectors = deps.connectors.forWorkspace(target.workspaceId);
  const connectorIds = new Map<string, string>();
  for (const connector of seed.connectors) {
    const made = await connectors.create(
      {
        name: connector.name,
        transport: 'stdio',
        command: DEMO_TEMPLATE_CONNECTOR_COMMAND,
        args: templateConnectorArgs(connector.reads, connector.writes, connector.recorded),
        url: null,
        authType: 'none',
        credential: null,
      },
      target.owner,
    );
    if (made.kind !== 'created')
      throw new Error(`the demo connector ${connector.name} was not made: ${made.kind}`);
    connectorIds.set(connector.name, made.server.id);
  }
  return connectorIds;
}

/** The template's skills, through the skills domain: the ids of the definition's, in its order. */
async function makeSkills(
  deps: SeedFillDependencies,
  target: FillTarget,
  seed: DemoTemplateSeed,
): Promise<readonly string[]> {
  const { workspaceId, owner } = target;
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

/** The definition's file grants, resolved to the ids of the files saved in the template. */
async function resolveFileGrants(
  deps: SeedFillDependencies,
  workspaceId: string,
  definition: AgentDefinition,
): Promise<{ fileId: string; access: 'read' | 'read-write' }[]> {
  const catalog = await deps.catalogs(workspaceId);
  const files: { fileId: string; access: 'read' | 'read-write' }[] = [];
  for (const grant of definition.resources.files) {
    const row = await catalog.get(grant.path);
    if (row === null)
      throw invalid(`the definition grants ${grant.path}, which is not in the template`);
    files.push({ fileId: row.id, access: grant.access });
  }
  return files;
}

async function createAgent(
  deps: SeedFillDependencies,
  target: FillTarget,
  definition: AgentDefinition,
  links: AgentLinks,
): Promise<void> {
  const { workspaceId, owner } = target;
  const { connectorIds, skillIds } = links;
  const files = await resolveFileGrants(deps, workspaceId, definition);
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
      connectorIds: definition.resources.connectors.flatMap((name) => connectorIds.get(name) ?? []),
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
    if (stored.kind !== 'updated') throw new Error(`the demo agent ${agent.name} lost its policy`);
  }
}

/** The member the template's rows are made as: the entry's template-owner account. */
async function templateOwner(
  deps: SeedFillDependencies,
  workspaceId: string,
): Promise<TemplatePrincipal> {
  const members = await deps.directory.forWorkspace(workspaceId).listMemberships();
  const member = members[0];
  if (member === undefined) throw new Error('the demo template has no owner');
  return { principalId: member.principalId, userId: member.userId };
}

/** Fill the template workspace from the seed; the digest is saved last. */
export async function fillTemplate(
  deps: SeedFillDependencies,
  workspaceId: string,
  seed: DemoTemplateSeed,
  digest: string,
): Promise<void> {
  const target: FillTarget = { workspaceId, owner: await templateOwner(deps, workspaceId) };
  await saveSamples(deps, target, seed);
  await makeScratchFolders(deps, target, seed);
  const connectorIds = await makeConnectors(deps, target, seed);
  const skillIds = await makeSkills(deps, target, seed);
  await createAgent(deps, target, seed.definition, { connectorIds, skillIds });
  // The digest last: a seed that stopped before it is made again by the next.
  await saveFile(deps, target, {
    path: DEMO_TEMPLATE_DIGEST_PATH,
    body: new TextEncoder().encode(digest),
    contentType: 'text/plain',
  });
}
