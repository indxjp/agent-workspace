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
import {
  DEMO_TEMPLATE_SLUG_PREFIX,
  demoTemplateWorkspaceSlug,
  type DemoEntrySlug,
} from '@indx-workspace/contracts/demo';
import type {
  DemoTemplateReports,
  DemoTemplateSeed,
} from '@indx-workspace/contracts/demo-operator';

import type { AgentRecord } from '../../agents';
import type { DemoTemplateOperations } from '../operator';
import { allCatalogRows, type CatalogFile } from './catalog-rows';
import { checkSeed, DemoSeedRefusal } from './seed-check';
import { fillTemplate, type SeedFillDependencies } from './seed-fill';
import {
  DEMO_TEMPLATE_DIGEST_PATH,
  RECORDS_PREFIX,
  isReservedPath,
  seedDigest,
} from './template-layout';
import { DEMO_TEMPLATE_OWNER_DOMAIN, isDeploymentTemplate } from './template-owner';

export { checkSeed, DemoSeedRefusal };

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

export interface DemoTemplateSeedDependencies extends SeedFillDependencies {
  readonly workspaceIdForSlug: (slug: string) => Promise<string | null>;
  readonly workspaces: TemplateWorkspaces;
}

/** The template-owner account of an entry. */
export const templateOwnerEmail = (entry: DemoEntrySlug): string =>
  `${entry}@${DEMO_TEMPLATE_OWNER_DOMAIN}`;

const isActive = (agent: AgentRecord): boolean => agent.archivedAt === undefined;

async function textOf(
  deps: DemoTemplateSeedDependencies,
  workspaceId: string,
  row: CatalogFile,
): Promise<string | null> {
  const opened = await deps.storage.open({ workspaceId }, row);
  return opened === null ? null : await new Response(opened.body).text();
}

/** The workspace of `entry`, made when it is missing; refused when it is not the deployment's. */
async function templateWorkspace(
  deps: DemoTemplateSeedDependencies,
  entry: DemoEntrySlug,
  now: Date,
): Promise<string> {
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
async function storedDigest(
  deps: DemoTemplateSeedDependencies,
  workspaceId: string,
): Promise<string | null> {
  const row = await (await deps.catalogs(workspaceId)).get(DEMO_TEMPLATE_DIGEST_PATH);
  return row === null || row.kind !== 'file'
    ? null
    : ((await textOf(deps, workspaceId, row))?.trim() ?? null);
}

/** Delete the template's skills, through the skills domain. */
async function wipeSkills(deps: DemoTemplateSeedDependencies, workspaceId: string): Promise<void> {
  const skills = deps.skills;
  if (skills === null) return;
  for (const skill of await skills.list(workspaceId)) {
    const removed = await skills.remove(workspaceId, skill.name);
    if (removed.kind !== 'removed' && removed.kind !== 'not-found') {
      throw new Error(`the demo template skill ${skill.name} was not removed: ${removed.kind}`);
    }
  }
}

/** Delete every file and folder of the template, the deepest rows first. */
async function wipeFiles(deps: DemoTemplateSeedDependencies, workspaceId: string): Promise<void> {
  // The deepest rows first, so a folder is emptied before it is removed.
  const rows = [...(await allCatalogRows(deps.catalogs, workspaceId))].sort(
    (a, b) => b.path.length - a.path.length,
  );
  for (const row of rows) {
    const removed = await deps.storage.remove({ workspaceId }, 'files', row.path, {
      recursive: row.kind === 'folder',
    });
    if (!removed.ok && removed.code !== 'not_found') {
      throw new Error(`the demo template file ${row.path} was not removed: ${removed.code}`);
    }
  }
}

/** Delete what a seed made: the agents, the skills, the connectors, and every file and folder. */
async function wipe(deps: DemoTemplateSeedDependencies, workspaceId: string): Promise<void> {
  const agents = deps.agents.forWorkspace(workspaceId);
  for (const agent of await agents.list()) await agents.delete(agent.id);
  // The agents first, so no skill is still assigned.
  await wipeSkills(deps, workspaceId);
  const connectors = deps.connectors.forWorkspace(workspaceId);
  for (const connector of await connectors.list()) await connectors.delete(connector.id);
  await wipeFiles(deps, workspaceId);
}

/** What one template workspace holds, for the operator's report; `null` for a workspace not ours. */
async function reportTemplate(
  deps: DemoTemplateSeedDependencies,
  slug: string,
): Promise<DemoTemplateReports['templates'][number] | null> {
  const workspaceId = await deps.workspaceIdForSlug(slug);
  if (workspaceId === null || !(await isDeploymentTemplate(deps.directory, workspaceId)))
    return null;
  const agent = (await deps.agents.forWorkspace(workspaceId).list()).find(isActive);
  const rows = await allCatalogRows(deps.catalogs, workspaceId);
  const sets = rows.filter((row) => row.kind === 'file' && row.path.startsWith(RECORDS_PREFIX));
  return {
    entry: slug.slice(DEMO_TEMPLATE_SLUG_PREFIX.length),
    agent: agent?.name ?? null,
    files: rows.filter((row) => row.kind === 'file' && !isReservedPath(row.path)).length,
    recordSets: sets.length,
  };
}

async function seedTemplate(
  deps: DemoTemplateSeedDependencies,
  input: { readonly entry: DemoEntrySlug; readonly seed: DemoTemplateSeed; readonly now: Date },
): Promise<{ changed: boolean }> {
  const { entry, seed, now } = input;
  checkSeed(seed);
  const digest = seedDigest(seed);
  const workspaceId = await templateWorkspace(deps, entry, now);
  const agents = (await deps.agents.forWorkspace(workspaceId).list()).filter(isActive);
  if (agents.length > 0 && (await storedDigest(deps, workspaceId)) === digest) {
    return { changed: false };
  }
  await wipe(deps, workspaceId);
  await fillTemplate(deps, workspaceId, seed, digest);
  return { changed: true };
}

export function createDemoTemplateOperations(
  deps: DemoTemplateSeedDependencies,
): DemoTemplateOperations {
  return {
    seed: (input) => seedTemplate(deps, input),

    async report(): Promise<DemoTemplateReports> {
      const templates: DemoTemplateReports['templates'][number][] = [];
      for (const slug of [...(await deps.workspaces.templateSlugs())].sort()) {
        const template = await reportTemplate(deps, slug);
        if (template !== null) templates.push(template);
      }
      return { templates };
    },
  };
}
