import type { AgentGrantStoreProvider } from '../../agents/agent-grants-store';
import type { AgentResourceStoreProvider } from '../../agents/resource-store';
import type { AgentStoreProvider } from '../../agents/store';
import type { ClientIdentitySettings } from '../../client-identity';
import { systemClock } from '../../clock';
import type { ConnectorsStoreProvider } from '../../connectors/store';
import { createLeadStore, type StoreLeadRepository } from '../../demo/adapters/leads/store';
import { createDemoProvisioner } from '../../demo/provision/binder';
import type { DemoRuntimeDriver, DemoTemplates } from '../../demo/provision/ports';
import { createDemoTemplates } from '../../demo/provision/template-copy';
import type { FilesRuntime } from '../../files/runtime';
import { createGuestWorkspaceBinder } from '../../email-link/adapters/guest-workspace/production';
import {
  createEmailLinkService,
  type EmailLinkCompositionDependencies,
} from '../../email-link/transport/composition';
import type { EmailLinkRuntime } from '../../email-link/transport/routes';
import { randomIds } from '../../ids';
import type { ModelsStoreProvider } from '../../models/store';
import type { DirectoryRoot } from '../../rbac/directory';
import { enforceableNetworkPoliciesFromRegistry } from '../../runtimes/registry';
import type { RuntimeProfileStoreProvider } from '../../runtimes/store';
import type { WebSettings } from '../../settings';
import type { Skills } from '../../skills/runtime';
import { skillCatalogOf } from '../../skills/store';
import { createWorkspaceSkills, type WorkspaceSkills } from '../../skills/workspace-skills';
import { runnerManagerDriverId } from '../config';

/**
 * The domains the demo provisioner copies a template through. A deployment without object storage
 * or without agent grants has no `files.storage` or `agentGrants`; it then has no demo to offer
 * (`hasEntry` is `false` for every entry, so the sign-in answers `demo_entry_unavailable`), and
 * leads are still recorded.
 */
export interface DemoProvisionerDomains {
  readonly agents: AgentStoreProvider;
  readonly agentResources?: AgentResourceStoreProvider | undefined;
  readonly agentGrants?: AgentGrantStoreProvider | undefined;
  /** `null` where the deployment serves no connectors. */
  readonly connectors: ConnectorsStoreProvider | null;
  readonly files: Pick<FilesRuntime, 'catalog' | 'storage'>;
  /** The models domain, where a demo workspace's `default` connection is made; `null` without it. */
  readonly models?: ModelsStoreProvider | null | undefined;
  /** The runtimes domain, where a demo workspace's sandbox profile is made; `null` without it. */
  readonly runtimeProfiles?: RuntimeProfileStoreProvider | null | undefined;
  /**
   * The skills domain, where a template's skills are seeded and a copy's are made; `null` without
   * it, and a template agent that has a skill is then neither seeded nor copied.
   */
  readonly skills?: WorkspaceSkills | null | undefined;
  /**
   * The runtime driver the deployment launches runs on (the runner manager's driver, or `local`
   * where only a fixed runtime URL is set), which the demo's sandbox profile is made on; `null`
   * where none is configured, and a demo run is then refused.
   */
  readonly runtimeDriver?: DemoRuntimeDriver | null | undefined;
}

/**
 * The runtime driver the demo's sandbox profile is made on: the one this deployment launches runs
 * with, where a runner manager allocates the runtime (its `RUNTIME_DRIVER`). The `local` driver
 * (a fixed `RUNNER_URL`, or `RUNTIME_DRIVER=local`) runs with the host's network and cannot enforce
 * `none`, so it is `null` like no runtime at all: no demo profile is made and a demo run is refused.
 */
export function demoRuntimeDriverOf(input: {
  readonly runnerManager: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}): DemoRuntimeDriver | null {
  if (!input.runnerManager) return null;
  const driver = runnerManagerDriverId(input.env);
  return driver === 'local' ? null : driver;
}

/**
 * Whether the installed runtime registry says `driver` enforces the network policy `none`. A
 * driver the registry does not restrict (or no registry) is taken at its word, as the
 * runtime-profile routes do; a driver whose advertised policies leave out `none` gets no demo profile.
 */
export async function demoDriverEnforcesNoNetwork(driver: DemoRuntimeDriver): Promise<boolean> {
  if (driver === 'local') return false;
  const policies = await enforceableNetworkPoliciesFromRegistry(driver);
  return policies === null || policies.includes('none');
}

/**
 * The skills domain as the demo handles it (`skills/workspace-skills.ts`): the skills routes' own
 * sequence over the deployment's skills storage and catalog. `null` while the skills domain is not
 * serving or has no catalog.
 */
export function demoSkillsOf(skills: Skills): WorkspaceSkills | null {
  if (skills.kind !== 'serving') return null;
  const { store, catalog, storage } = skills.runtime;
  if (catalog === undefined || storage === undefined) return null;
  return createWorkspaceSkills({
    objects: (workspaceId) => store.forWorkspace(workspaceId),
    catalog: async (workspaceId) => skillCatalogOf(await catalog.forWorkspace(workspaceId)),
    storage,
  });
}

/** What the provisioner needs of the workspace scopes: the id of the workspace with a slug. */
export interface WorkspaceSlugScopes {
  forWorkspaceSlug(slug: string): Promise<{ readonly workspaceId: string } | null>;
}

/** The templates of a deployment that cannot copy one: no entry has a demo. */
const NO_TEMPLATES: DemoTemplates = {
  exists: () => Promise.resolve(false),
  copyInto: () => Promise.reject(new Error('this deployment has no demo templates')),
  copyIntoVerification: () => Promise.reject(new Error('this deployment has no demo templates')),
};

export function demoTemplatesOf(
  domains: DemoProvisionerDomains,
  scopes: WorkspaceSlugScopes,
  directory: DirectoryRoot,
  anthropicApiKey: string | null = null,
): DemoTemplates {
  const { agentResources, agentGrants, models, runtimeProfiles } = domains;
  const { catalog, storage } = domains.files;
  if (agentResources === undefined || agentGrants === undefined) return NO_TEMPLATES;
  if (domains.connectors === null) return NO_TEMPLATES;
  if (catalog === undefined || storage === undefined) return NO_TEMPLATES;
  // A demo runs on a model connection and a sandbox profile it makes itself, so it needs both domains.
  if (models == null || runtimeProfiles == null) return NO_TEMPLATES;
  return createDemoTemplates({
    workspaceIdForSlug: async (slug) => (await scopes.forWorkspaceSlug(slug))?.workspaceId ?? null,
    directory,
    agents: domains.agents,
    resources: agentResources,
    grants: agentGrants,
    connectors: domains.connectors,
    catalogs: (workspaceId) => catalog.forWorkspace(workspaceId),
    storage,
    models,
    runtimeProfiles,
    skills: domains.skills ?? null,
    sandbox: {
      runtimeDriver: domains.runtimeDriver ?? null,
      anthropicApiKey,
      enforcesNoNetwork: demoDriverEnforcesNoNetwork,
    },
  });
}

/**
 * Build the email-link sign-in (`/api/auth/email-link`) for the composition root to install as
 * `ApplicationContext.emailLink`. The settings are the ones the root parsed once at start-up; an
 * unset sender or base URL does not stop start-up, it makes the issue route answer
 * `503 email_link_unavailable`, and an unknown sender name does stop it (the sender adapter throws).
 */
export function wireEmailLink(input: {
  /** The root, typed by the email-link composition: the one file that names the repository. */
  readonly root: {
    readonly loginTokens: EmailLinkCompositionDependencies['loginTokens'];
    readonly storeLeads: StoreLeadRepository;
    readonly scopes: WorkspaceSlugScopes;
  };
  readonly directory: DirectoryRoot;
  readonly domains: DemoProvisionerDomains;
  readonly settings: Pick<
    WebSettings,
    'emailLinkBaseUrl' | 'emailLinkSender' | 'emailLinkChallenge' | 'demo' | 'demoAnthropicApiKey'
  >;
  readonly clientIdentity: ClientIdentitySettings;
}): EmailLinkRuntime {
  return {
    kind: 'ready',
    clock: systemClock,
    service: createEmailLinkService({
      clock: systemClock,
      ids: randomIds,
      clientIdentity: input.clientIdentity,
      settings: {
        linkBaseUrl: input.settings.emailLinkBaseUrl,
        sender: input.settings.emailLinkSender,
        challenge: input.settings.emailLinkChallenge,
      },
      loginTokens: input.root.loginTokens,
      binder: createDemoProvisioner({
        directoryBinder: createGuestWorkspaceBinder({ directory: input.directory, ids: randomIds }),
        templates: demoTemplatesOf(
          input.domains,
          input.root.scopes,
          input.directory,
          input.settings.demoAnthropicApiKey,
        ),
        leads: createLeadStore(input.root.storeLeads),
        limits: {
          maxTurns: input.settings.demo.maxTurnsPerRun,
          maxBudgetUsd: input.settings.demo.maxCostPerRunUsd,
        },
      }),
    }),
  };
}
