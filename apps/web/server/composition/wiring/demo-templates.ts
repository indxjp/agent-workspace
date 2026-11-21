/**
 * Template seeding and the sample check (`PUT`/`GET /api/demo/templates`): what the deploy's
 * operator step and the nightly sample check call, over the same domains the provisioner copies a
 * template through. A deployment without one of them has no template operations (`null`).
 */
import { DEMO_TEMPLATE_SLUG_PREFIX } from '@indx-workspace/contracts/demo';

import { OWNER_BINDING_SECONDS } from '../../demo/provision/limits';
import { createDemoTemplateOperations, type TemplateWorkspaces } from '../../demo/provision/seed';
import { createDemoVerification } from '../../demo/provision/verification';
import type { DemoTemplateOperations, DemoVerificationOperations } from '../../demo/operator';
import { demoWorkspaceSlug } from '../../email-link/adapters/guest-workspace/production';
import { randomIds, type IdGenerator } from '../../ids';
import type { DirectoryRoot } from '../../rbac/directory';
import type { DemoSettings, WebSettings } from '../../settings';
import {
  demoTemplatesOf,
  type DemoProvisionerDomains,
  type WorkspaceSlugScopes,
} from './email-link';

/** What the composition root hands the template operations: the provisioner's own domains. */
export interface DemoTemplateWiring {
  readonly scopes: WorkspaceSlugScopes;
  readonly directory: DirectoryRoot;
  readonly domains: DemoProvisionerDomains;
  readonly settings: Pick<WebSettings, 'demoAnthropicApiKey'> & {
    /** The visitor's caps, which a verification copy gets too. */
    readonly demo: Pick<DemoSettings, 'maxTurnsPerRun' | 'maxCostPerRunUsd'>;
  };
  /** The workspaces repository and the id list the template workspaces are made and found through. */
  readonly workspaces: WorkspaceRepositoryView;
}

/** What the template workspaces need of the database root: the root itself satisfies it. */
export interface WorkspaceRepositoryView {
  readonly workspaces: TemplateWorkspaceRepository;
  listWorkspaceIds(): Promise<readonly string[]>;
  /** Where the verification fill marks its workspace (ADR-0169 D3). */
  readonly demoCaps: {
    markVerificationWorkspace(workspaceId: string, now: Date): Promise<void>;
  };
}

/** The two workspace repository calls a template is made and found with. */
export interface TemplateWorkspaceRepository {
  create(input: {
    readonly name: string;
    readonly slug: string;
    readonly ownerUserId: string;
  }): Promise<
    | { readonly kind: 'created'; readonly workspace: { readonly id: string } }
    | { readonly kind: 'conflict'; readonly slug: string }
    | { readonly kind: 'invalid-slug'; readonly slug: string }
    | { readonly kind: 'invalid-name' }
  >;
  get(id: string): Promise<{ readonly slug: string } | null>;
}

/**
 * The template workspaces over the directory and the workspaces repository: a template is made by
 * giving the owner account a user row (the directory's guest binding is the one place that makes a
 * user with no workspace), then creating the workspace with that user as its Owner, atomically.
 * The owner's user is created with the entry's own address, so the binding is never refused as an
 * address that holds another role.
 */
export function createTemplateWorkspaces(input: {
  readonly directory: Pick<DirectoryRoot, 'bindGuestWorkspace'>;
  readonly workspaces: TemplateWorkspaceRepository;
  readonly listWorkspaceIds: () => Promise<readonly string[]>;
  readonly ids: IdGenerator;
}): TemplateWorkspaces {
  return {
    async make({ slug, name, ownerEmail, now }) {
      const workspaceId = input.ids.newId();
      const binding = await input.directory.bindGuestWorkspace({
        email: ownerEmail,
        now,
        workspaceId,
        slug: demoWorkspaceSlug(workspaceId),
        lifetimeSeconds: OWNER_BINDING_SECONDS,
      });
      if (binding === null) throw new Error(`the template owner ${ownerEmail} cannot be made`);
      const created = await input.workspaces.create({ name, slug, ownerUserId: binding.userId });
      if (created.kind === 'created') return created.workspace.id;
      if (created.kind === 'conflict') return null;
      throw new Error(`the template workspace ${slug} was refused: ${created.kind}`);
    },

    // Every workspace is read once: there is no listing by slug, and a deployment that serves the
    // store holds only the templates and the demo workspaces of the last day.
    async templateSlugs() {
      const slugs: string[] = [];
      for (const id of await input.listWorkspaceIds()) {
        const slug = (await input.workspaces.get(id))?.slug;
        if (slug?.startsWith(DEMO_TEMPLATE_SLUG_PREFIX) === true) slugs.push(slug);
      }
      return slugs;
    },
  };
}

/** Whether the deployment has every domain a template is filled and copied through. */
function canHoldTemplates(domains: DemoProvisionerDomains) {
  const { agentResources, agentGrants, connectors } = domains;
  const { catalog, storage } = domains.files;
  if (agentResources === undefined || agentGrants === undefined || connectors === null) return null;
  if (catalog === undefined || storage === undefined) return null;
  return { connectors, catalog, storage, agents: domains.agents };
}

export function wireDemoTemplateOperations(
  input: DemoTemplateWiring,
): DemoTemplateOperations | null {
  const held = canHoldTemplates(input.domains);
  if (held === null) return null;
  return createDemoTemplateOperations({
    workspaceIdForSlug: async (slug) =>
      (await input.scopes.forWorkspaceSlug(slug))?.workspaceId ?? null,
    workspaces: createTemplateWorkspaces({
      directory: input.directory,
      workspaces: input.workspaces.workspaces,
      listWorkspaceIds: () => input.workspaces.listWorkspaceIds(),
      ids: randomIds,
    }),
    directory: input.directory,
    agents: held.agents,
    connectors: held.connectors,
    catalogs: (workspaceId) => held.catalog.forWorkspace(workspaceId),
    storage: held.storage,
    skills: input.domains.skills ?? null,
  });
}

/**
 * The verification workspace fill (`PUT /api/demo/verification/{workspaceId}`): every template
 * `operations` reports with an agent, copied by the visitor's own copier (`demoTemplatesOf`) with
 * the visitor's caps. `null` where the deployment has no template operations.
 */
export function wireDemoVerification(
  input: DemoTemplateWiring,
  operations: DemoTemplateOperations | null,
): DemoVerificationOperations | null {
  if (operations === null) return null;
  return createDemoVerification({
    templates: demoTemplatesOf(
      input.domains,
      input.scopes,
      input.directory,
      input.settings.demoAnthropicApiKey,
    ),
    templateEntries: async () =>
      (await operations.report()).templates
        .filter((template) => template.agent !== null)
        .map((template) => template.entry),
    directory: input.directory,
    limits: {
      maxTurns: input.settings.demo.maxTurnsPerRun,
      maxBudgetUsd: input.settings.demo.maxCostPerRunUsd,
    },
    markVerificationWorkspace: (workspaceId, now) =>
      input.workspaces.demoCaps.markVerificationWorkspace(workspaceId, now),
  });
}
