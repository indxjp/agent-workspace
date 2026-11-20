/** Seeds a template workspace from a {@link TemplateSpec}: its files, records, connectors, skills and agent. */
import crypto from 'node:crypto';

import type { AgentResourceAssignments } from '@indx-workspace/contracts/agents';
import { demoTemplateWorkspaceSlug, type DemoEntrySlug } from '@indx-workspace/contracts/demo';

import { compiledPolicyFor, withStoredConnectorIds } from '../../agents/core/policy';
import type { StorageService } from '../../storage/service';
import type { WorkspaceSkills } from '../../skills/workspace-skills';
import type { TemplateSpec } from './templates.contract';
import { recordSetPath } from './template-layout';
import { DEMO_TEMPLATE_OWNER_DOMAIN } from './template-owner';
import type { WorkspaceOwner, WorldParts } from './templates.world.parts.test-support';
import { seedConnector } from './templates.world.seed-connector.test-support';

/** The largest file a seeded template holds. */
const MAX_SEEDED_FILE_BYTES = 1_000_000;

/** What seeding a template reaches for: the world's parts and the services over them. */
export interface TemplateSeeding {
  readonly parts: WorldParts;
  readonly storage: StorageService;
  readonly skills: WorkspaceSkills;
  readonly templateSlugs: Set<string>;
}

type SeedContext = WorkspaceOwner & { readonly workspaceId: string };
type Assigned = AgentResourceAssignments['files'][number];

function ownerEmailFor(madeBy: 'deployment' | 'person'): string {
  return madeBy === 'person'
    ? `${crypto.randomUUID()}@example.test`
    : `${crypto.randomUUID()}@${DEMO_TEMPLATE_OWNER_DOMAIN}`;
}

async function seedFiles(
  { storage }: TemplateSeeding,
  ctx: SeedContext,
  spec: TemplateSpec,
): Promise<void> {
  for (const file of spec.files) {
    const bytes = new TextEncoder().encode(file.text);
    const saved = await storage.save(ctx, {
      area: 'files',
      path: file.path,
      body: new Response(bytes).body ?? new ReadableStream(),
      maxBytes: MAX_SEEDED_FILE_BYTES,
      contentType: 'text/plain',
      replace: false,
    });
    if (!saved.ok) throw new Error(`seeding ${file.path}: ${saved.code}`);
  }
  for (const set of spec.records ?? []) {
    const saved = await storage.save(ctx, {
      area: 'files',
      path: recordSetPath(set),
      body: new Response(JSON.stringify(set)).body ?? new ReadableStream(),
      maxBytes: MAX_SEEDED_FILE_BYTES,
      contentType: 'application/json',
      replace: false,
    });
    if (!saved.ok) throw new Error(`seeding records of ${set.connector}: ${saved.code}`);
  }
}

/** The files the agent is assigned, by the rows the seeded files now have. */
async function assignedFiles(
  { parts }: TemplateSeeding,
  workspaceId: string,
  spec: TemplateSpec,
): Promise<Assigned[]> {
  const catalog = await parts.catalogs(workspaceId);
  const assigned: Assigned[] = [];
  for (const grant of spec.assign) {
    const row = await catalog.get(grant.path);
    if (row === null) throw new Error(`seeding: no row at ${grant.path}`);
    assigned.push({ fileId: row.id, access: grant.access });
  }
  return assigned;
}

/** Make the spec's connectors; their ids in order, and by name for the rules. */
async function seedConnectors(
  { parts }: TemplateSeeding,
  ctx: SeedContext,
  spec: TemplateSpec,
): Promise<{ ids: string[]; idsByName: Map<string, string> }> {
  const store = parts.connectors.forWorkspace(ctx.workspaceId);
  const ids: string[] = [];
  const idsByName = new Map<string, string>();
  for (const connector of spec.connectors ?? []) {
    const id = await seedConnector(store, connector, {
      principalId: ctx.principalId,
      userId: ctx.userId,
    });
    ids.push(id);
    idsByName.set(connector.name, id);
  }
  return { ids, idsByName };
}

/** Make the spec's skills in the template: a built-in from the release, any other from its files. */
async function seedSkills(
  { skills }: TemplateSeeding,
  workspaceId: string,
  owner: WorkspaceOwner,
  specs: NonNullable<TemplateSpec['skills']>,
): Promise<string[]> {
  const ids: string[] = [];
  for (const spec of specs) {
    if (spec.files === undefined) {
      await skills.installBuiltins(workspaceId, owner, [spec.name]);
      const id = (await skills.list(workspaceId)).find((skill) => skill.name === spec.name)?.id;
      if (id === undefined) throw new Error(`seeding the built-in skill ${spec.name}`);
      ids.push(id);
      continue;
    }
    const made = await skills.create(workspaceId, owner, {
      name: spec.name,
      files: Object.entries(spec.files).map(([path, text]) => ({
        path,
        bytes: new TextEncoder().encode(text),
      })),
    });
    if (made.kind !== 'created') throw new Error(`seeding the skill ${spec.name}: ${made.kind}`);
    ids.push(made.id);
  }
  return ids;
}

/** The policy the agent is stored with: compiled from its permissions, plus its rules and limits. */
function storedPolicy(
  spec: TemplateSpec,
  permissions: Parameters<typeof compiledPolicyFor>[0],
  idsByName: ReadonlyMap<string, string>,
) {
  const base = compiledPolicyFor(
    permissions,
    (spec.skills ?? []).map((skill) => skill.name),
  );
  // Rules are written by connector name, and stored by id, as the agents routes store them.
  const ruled = withStoredConnectorIds(
    {
      ...base,
      tools: {
        ...base.tools,
        autoApprove: [...base.tools.autoApprove, ...(spec.rules?.autoApprove ?? [])],
        deny: [...base.tools.deny, ...(spec.rules?.deny ?? [])],
      },
    },
    idsByName,
  );
  return {
    ...ruled,
    limits: { maxTurns: spec.agent.maxTurns, maxBudgetUsd: spec.agent.maxBudgetUsd },
  };
}

export async function seedTemplateWorkspace(
  seeding: TemplateSeeding,
  entry: DemoEntrySlug,
  spec: TemplateSpec,
  madeBy: 'deployment' | 'person',
): Promise<void> {
  const { parts, templateSlugs } = seeding;
  const slug = demoTemplateWorkspaceSlug(entry);
  templateSlugs.add(slug);
  const template = await parts.makeWorkspace(slug, ownerEmailFor(madeBy));
  const owner = { principalId: template.principalId, userId: template.userId };
  const ctx = { workspaceId: template.id, ...owner };
  await seedFiles(seeding, ctx, spec);
  const assigned = await assignedFiles(seeding, template.id, spec);
  const connectors = await seedConnectors(seeding, ctx, spec);
  const skillIds = await seedSkills(seeding, template.id, owner, spec.skills ?? []);
  const permissions = {
    readFiles: true,
    writeFiles: false,
    runCommands: false,
    unrestrictedNetwork: spec.agent.unrestrictedNetwork ?? false,
  };
  const agents = parts.agents.forWorkspace(template.id);
  const made = await agents.createWithAssignments(
    {
      name: spec.agent.name,
      instructions: spec.agent.instructions,
      modelConnectionId: null,
      model: null,
      permissions,
    },
    owner,
    { files: assigned, skillIds, connectorIds: connectors.ids },
  );
  if (made.kind !== 'created') throw new Error(`seeding the agent: ${made.kind}`);
  if (spec.policy === 'compiled') return;
  await agents.replacePolicy(made.agent.id, storedPolicy(spec, permissions, connectors.idsByName));
}
