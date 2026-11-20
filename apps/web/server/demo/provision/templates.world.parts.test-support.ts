/**
 * What a templates world is made of ({@link WorldParts}) and the defaults every world shares. The
 * memory and PostgreSQL worlds differ only in these parts.
 */
import type { AgentGrantStoreProvider } from '../../agents/agent-grants-store';
import type { AgentResourceStoreProvider } from '../../agents/resource-store';
import type { AgentStoreProvider } from '../../agents/store';
import type { ConnectorsStoreProvider } from '../../connectors/store';
import type { ModelsStoreProvider } from '../../models/store';
import type { DirectoryRoot } from '../../rbac/directory';
import type { RuntimeProfileStoreProvider } from '../../runtimes/store';
import type { CatalogPort } from '../../storage/store';
import type { SkillCatalog } from '../../skills/ports';
import type { DemoSandbox } from './ports';
import { TEST_DEMO_API_KEY } from './templates.contract';

/** The demo key and driver a world gives its provisioner unless a test says otherwise. */
export const TEST_DEMO_SANDBOX: DemoSandbox = {
  runtimeDriver: 'docker',
  anthropicApiKey: TEST_DEMO_API_KEY,
  enforcesNoNetwork: () => Promise.resolve(true),
  verifyRuntime: () => Promise.resolve(),
};

/** The owner a template workspace is made with, and its seeding identity. */
export interface WorkspaceOwner {
  readonly principalId: string;
  readonly userId: string | null;
}

/** A workspace a world made: its id and its one Owner. */
export interface MadeWorkspace extends WorkspaceOwner {
  readonly id: string;
}

/** The parts a world is made of; the two worlds differ in these. */
export interface WorldParts {
  readonly directory: DirectoryRoot;
  readonly agents: AgentStoreProvider;
  readonly resources: AgentResourceStoreProvider;
  readonly grants: AgentGrantStoreProvider;
  readonly connectors: ConnectorsStoreProvider;
  readonly models: ModelsStoreProvider;
  readonly runtimeProfiles: RuntimeProfileStoreProvider;
  readonly catalogs: (workspaceId: string) => Promise<CatalogPort>;
  /** The skills catalog of a workspace: the same catalog, as the skills domain reads it. */
  readonly skillCatalogs: (workspaceId: string) => Promise<SkillCatalog>;
  /** Make the workspace `slug` with `ownerEmail` as its one Owner (a template, or a person's). */
  readonly makeWorkspace: (slug: string, ownerEmail: string) => Promise<MadeWorkspace>;
  readonly workspaceIdForSlug: (slug: string) => Promise<string | null>;
}
