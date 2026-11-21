/**
 * The world a {@link DemoTemplates} conformance run is written against: its spec and port types, and
 * the fixtures every group of `templates.contract.ts` shares.
 */
import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';
import type { DemoRecordedWrite, DemoSampleRecords } from '@indx-workspace/contracts/demo-operator';
import type { AgentResourceAssignments } from '@indx-workspace/contracts/agents';

import type { AgentRecord, WorkspaceSkills } from '../../agents';
import type { DirectoryRoot } from '../../identity';
import type {
  AnyConnectorResource,
  ConnectorsStoreProvider,
  WorkspaceModelsStore,
} from '../../integrations';
import type { RuntimeProfileRecord, RuntimeProfileStoreProvider } from '../../execution';
import type { DemoTemplateOperations } from '../operator';
import type { DemoRunLimits, DemoSandbox, DemoTemplates } from './ports';

/** One connector a template agent is given. */
export type SeedConnector =
  | { readonly kind: 'mcp'; readonly name: string }
  | { readonly kind: 'openapi-read'; readonly name: string }
  | { readonly kind: 'openapi-write'; readonly name: string }
  | { readonly kind: 'postgres'; readonly name: string }
  /** What the deployment's seed stores (`template-connector.ts`): read and write tools declared. */
  | {
      readonly kind: 'declared';
      readonly name: string;
      readonly reads: readonly string[];
      readonly writes: readonly string[];
      /** The writes the demo keeps once a person approved them (ADR-0169). */
      readonly recorded?: readonly DemoRecordedWrite[];
    };

export interface TemplateSpec {
  readonly agent: {
    readonly name: string;
    readonly instructions: string;
    readonly unrestrictedNetwork?: boolean;
    readonly maxTurns: number | null;
    readonly maxBudgetUsd: number | null;
  };
  /** The files in the template workspace, by path. */
  readonly files: readonly { readonly path: string; readonly text: string }[];
  /** What the template agent is assigned: a folder or a file path in the template. */
  readonly assign: readonly { readonly path: string; readonly access: 'read' | 'read-write' }[];
  /** The connectors the template agent is assigned. */
  readonly connectors?: readonly SeedConnector[];
  /** The entry's sample record sets, kept in the template's reserved folder. */
  readonly records?: readonly DemoSampleRecords[];
  /** Tool rules on the template agent, written by connector name (`mcp__<name>__<tool>`). */
  readonly rules?: {
    readonly autoApprove?: readonly string[];
    readonly deny?: readonly string[];
  };
  /**
   * The skills the template agent is assigned, made in the template: one with `files` (path to
   * text) from them, one without as a built-in from the platform's release.
   */
  readonly skills?: readonly {
    readonly name: string;
    readonly files?: Readonly<Record<string, string>>;
  }[];
  /** `compiled` leaves the template agent with no stored policy; by default it has one. */
  readonly policy?: 'stored' | 'compiled';
}

export interface DemoTemplatesWorld {
  readonly templates: DemoTemplates;
  /** What the deployment's operator step calls to fill the templates (`seed.ts`). */
  readonly operations: DemoTemplateOperations;
  /** The id of the workspace with the entry's template slug, or `null`. */
  templateId(entry: DemoEntrySlug): Promise<string | null>;
  /** The directory the visitors' demo workspaces are bound in. */
  readonly directory: DirectoryRoot;
  /** An entry slug no other test in this database uses. */
  entry(local: string): DemoEntrySlug;
  /**
   * Fill the entry's template workspace. `madeBy` is who created the workspace: the deployment
   * (a template-owner account) or a person (an ordinary address, as `POST /api/workspaces` would).
   */
  seedTemplate(
    entry: DemoEntrySlug,
    spec: TemplateSpec,
    madeBy?: 'deployment' | 'person',
  ): Promise<void>;
  /** Make the agent's per-run limits as wide as a copy that stopped before its caps left them. */
  uncap(workspaceId: string, agentId: string): Promise<void>;
  /** A new demo workspace with its guest, made by the email-link binder. */
  newGuest(): Promise<{
    readonly workspaceId: string;
    readonly userId: string;
    principalId: string;
  }>;
  /** A new ordinary workspace a person made, with that person as its one Owner. */
  newWorkspace(): Promise<{
    readonly workspaceId: string;
    readonly userId: string;
    readonly principalId: string;
  }>;
  agents(workspaceId: string): Promise<readonly AgentRecord[]>;
  assignments(workspaceId: string, agentId: string): Promise<AgentResourceAssignments | null>;
  /** The text of the file at `path`, or `null` when the workspace has none. */
  fileText(workspaceId: string, path: string): Promise<string | null>;
  /** The paths of every ready file and folder row of the workspace. */
  paths(workspaceId: string): Promise<readonly string[]>;
  /** The path of the row with `fileId` in the workspace, or `null`. */
  pathOf(workspaceId: string, fileId: string): Promise<string | null>;
  connectors(workspaceId: string): Promise<readonly AnyConnectorResource[]>;
  /** The connectors domain itself, as the run API's demo wiring hands it to the recorder (ADR-0169). */
  readonly connectorStores: Pick<ConnectorsStoreProvider, 'forWorkspace'>;
  /** The workspace's model connections store, as the models domain hands it out. */
  models(workspaceId: string): WorkspaceModelsStore;
  /** The workspace's runtime profiles. */
  profiles(workspaceId: string): Promise<readonly RuntimeProfileRecord[]>;
  /** The workspace's runtime profile store, to change a profile as a person with access might. */
  profileStore(workspaceId: string): ReturnType<RuntimeProfileStoreProvider['forWorkspace']>;
  /** Take the agent's runtime profile away, as a first copy that stopped early leaves it. */
  detachProfile(workspaceId: string, agentId: string): Promise<void>;
  /** The principals granted to run the agent. */
  granted(workspaceId: string, agentId: string): Promise<readonly string[] | null>;
  /** The workspace's skills, as the skills domain lists them. */
  skills(workspaceId: string): Promise<readonly { readonly id: string; readonly name: string }[]>;
  /** The skills domain the world's copies go through, to call it as another caller would. */
  readonly skillsDomain: WorkspaceSkills;
  /** How many complete revisions the skill `name` of the workspace has. */
  skillRevisions(workspaceId: string, name: string): Promise<number>;
  /** The text of each file of the skill `name`, by path, or `null` when there is no such skill. */
  skillFiles(workspaceId: string, name: string): Promise<Readonly<Record<string, string>> | null>;
}

export const SPEC: TemplateSpec = {
  agent: {
    name: 'sales-helper',
    instructions: 'You help a visitor with the sample deals.',
    maxTurns: 12,
    maxBudgetUsd: 0.6,
  },
  files: [
    { path: 'deals/q1.csv', text: 'id,amount\n1,100\n' },
    { path: 'deals/notes/a.txt', text: 'sample note' },
    { path: 'private/secrets.txt', text: 'not for the demo' },
  ],
  assign: [{ path: 'deals', access: 'read' }],
};

/** The demo key a world gives its provisioner unless a test says otherwise. */
export const TEST_DEMO_API_KEY = 'sk-ant-demo-key-for-tests-0123456789abcdef';

export const NO_LIMITS: DemoRunLimits = { maxTurns: null, maxBudgetUsd: null };
export const NOW = new Date('2026-11-16T09:00:00.000Z');

/** Makes a world, with the deployment's sandbox settings changed as a test needs. */
export type MakeDemoTemplatesWorld = (
  sandbox?: Partial<DemoSandbox>,
) => Promise<DemoTemplatesWorld>;

/** Copy the entry's template into the guest's workspace, as the provisioner does. */
export async function copy(
  world: DemoTemplatesWorld,
  entry: DemoEntrySlug,
  guest: { workspaceId: string; userId: string },
  limits: DemoRunLimits = NO_LIMITS,
): Promise<void> {
  await world.templates.copyInto({
    entry,
    workspaceId: guest.workspaceId,
    guestUserId: guest.userId,
    limits,
    now: NOW,
  });
}
