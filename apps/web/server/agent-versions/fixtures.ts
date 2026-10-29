/**
 * Test fixtures for the version routes (S1-05, issue #443): one valid create-version request and
 * the edits each refusal test makes to it. Plain data, so the parity, handler and route tests all
 * start from the same body.
 */
import type {
  AgentDefinitionResources,
  AgentPolicy,
  AgentPermissions,
} from '@indx-workspace/contracts/agents';
import type {
  CreateAgentFromVersionRequestInput,
  CreateAgentVersionRequestInput,
} from '@indx-workspace/contracts/agent-versions';
import type { SurfaceDefinitionInput } from '@indx-workspace/contracts/surfaces';

export const FIXTURE_AGENT_NAME = 'Support triage';

export const FIXTURE_PERMISSIONS: AgentPermissions = {
  readFiles: true,
  writeFiles: false,
  runCommands: false,
  unrestrictedNetwork: false,
};

export const FIXTURE_POLICY: Extract<AgentPolicy, { readonly engine: 'claude-agent-sdk' }> = {
  engine: 'claude-agent-sdk',
  tools: {
    base: 'claude_code_preset',
    autoApprove: [],
    deny: [],
    permissionMode: 'default',
    allowDangerouslySkipPermissions: false,
  },
  skills: { mode: 'all' },
  limits: { maxTurns: null, maxBudgetUsd: null },
};

export interface FixtureEdits {
  readonly policy?: AgentPolicy;
  readonly policySource?: 'stored' | 'compiled';
  readonly resources?: Partial<AgentDefinitionResources>;
  readonly modelConnectionName?: string | null;
  readonly runtimeProfileName?: string | null;
  readonly dryRun?: true;
  /** The agent's name; {@link FIXTURE_AGENT_NAME} when omitted. */
  readonly name?: string;
  readonly instructions?: string;
  /** The agent's permissions; {@link FIXTURE_PERMISSIONS} when omitted. */
  readonly permissions?: AgentPermissions;
  /** The version's `description` (ADR-0133); none when omitted. */
  readonly description?: string;
  /** Names of the subagents the version declares (ADR-0133 D14); none when omitted. */
  readonly subagents?: readonly string[];
  readonly surfaces?: readonly SurfaceDefinitionInput[];
  /** The bundles the version pins (issue #790); none when omitted. */
  readonly toolBundles?: readonly {
    readonly tool: string;
    readonly digest: string;
    readonly description?: string;
    readonly inputSchema?: Record<string, unknown>;
    readonly allowedDomains?: readonly string[];
    readonly secrets?: readonly string[];
  }[];
}

/** A create-version request that saves on a workspace with no named resources. */
export function versionRequest(edits: FixtureEdits = {}): CreateAgentVersionRequestInput {
  return {
    summary: 'First version',
    via: 'api',
    body: {
      definition: {
        apiVersion: 'agentworkspace.dev/v1',
        kind: 'AgentDefinition',
        agent: {
          name: edits.name ?? FIXTURE_AGENT_NAME,
          instructions: edits.instructions ?? 'Answer support mail.',
          permissions: edits.permissions ?? FIXTURE_PERMISSIONS,
          model: null,
          modelConnectionName: edits.modelConnectionName ?? null,
          runtimeProfileName: edits.runtimeProfileName ?? null,
        },
        policy: edits.policy ?? FIXTURE_POLICY,
        policySource: edits.policySource ?? 'stored',
        resources: { files: [], skills: [], connectors: [], ...edits.resources },
      },
      surfaces: edits.surfaces ?? [],
      ...(edits.description === undefined ? {} : { description: edits.description }),
      ...(edits.subagents === undefined
        ? {}
        : { subagents: edits.subagents.map((name) => ({ name })) }),
      ...(edits.toolBundles === undefined ? {} : { toolBundles: edits.toolBundles }),
    },
    ...(edits.dryRun === undefined ? {} : { dryRun: edits.dryRun }),
  };
}

/** The same request with `dryRun: true`. */
export function dryRunOf(request: CreateAgentVersionRequestInput): CreateAgentVersionRequestInput {
  return { ...request, dryRun: true };
}

/**
 * A `POST /api/agents {version}` request (S1-06): the same draft as {@link versionRequest} under
 * `version`, with `dryRun` (if any) beside it.
 */
export function fromVersionRequest(edits: FixtureEdits = {}): CreateAgentFromVersionRequestInput {
  const { dryRun, ...draftEdits } = edits;
  const { summary, via, body } = versionRequest(draftEdits);
  return {
    version: { summary, via, body },
    ...(dryRun === undefined ? {} : { dryRun }),
  };
}

/** A surface named `name` of `agent` (the fixture agent by default), the smallest one accepted. */
export function fixtureSurface(name: string, agent = FIXTURE_AGENT_NAME): SurfaceDefinitionInput {
  return { name, agent };
}
