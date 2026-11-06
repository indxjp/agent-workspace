import { randomUUID } from 'node:crypto';
import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import { AW_CONTROL_SERVER } from '@indx-workspace/contracts/builder';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import { type InMemoryAgentVersionStoreProvider } from '../../../agent-versions/memory-store';
import type { AgentRecord } from '../../../agents/contract';
import type { AuditDeps } from '../../adapters/audit/store';
import type { BuilderPorts } from '../../tools/types';
import type { ConnectorsStoreProvider } from '../../../connectors/store';
import type { WorkspaceFeatureStore } from '../../../workspaces/features-runtime';
import type { LaunchContext, RunApiEnvironment } from '../../../runs/environment';
import type { RunStore } from '../../../runs/store';

export const SECRET = 'builder-door-test-signing-secret-at-least-thirty-two-bytes';

export const WORKSPACE = randomUUID();

export const SESSION = randomUUID();

/** The built-in Builder agent the run belongs to, and the version its session pins. */
export const BUILDER_AGENT = randomUUID();

export const BUILDER_VERSION_ID = randomUUID();

/** The prefix the engine's MCP client puts before an `aw-control` tool's own name. */
export const TOOL_PREFIX = `mcp__${AW_CONTROL_SERVER}__`;

export const MEMBERS = {
  builder: 'principal-builder',
  viewer: 'principal-viewer',
  admin: 'principal-admin',
} as const;

/** One journal row as the audit adapter hands it to the repository. */
export type JournalRow = Parameters<ReturnType<AuditDeps['repositories']['forScope']>['record']>[0];

/** Who started the run: a member with this role, or a principal kind with no person. */
type Starter = { readonly role: keyof typeof MEMBERS } | { readonly apiKey: true };

/** What the scripted conversation holds after one turn: the model's messages and the tool results. */
export type Transcript = readonly { readonly role: string; readonly content: unknown }[];

export interface Door {
  /** The ports behind the door, spied: a second door (the external one) serves over the same stores. */
  readonly ports: BuilderPorts;
  readonly journal: readonly JournalRow[];
  /** The raw body of every `tools/call` response, in order, for checks on what leaves the door. */
  readonly responses: readonly string[];
  /** The headers of every `tools/call` response, in order, as JSON of their `[name, value]` pairs. */
  readonly responseHeaders: readonly string[];
  /** The version store behind the Builder's saves. */
  readonly versions: InMemoryAgentVersionStoreProvider;
  /** The workspace's `workspace_features` repository: `replaceDisabled(['builder'])` switches the Builder off. */
  readonly workspaceFeatures: WorkspaceFeatureStore;
  /** Every run the fake run API launched: a trial, an evaluation case, an approval continuation. */
  readonly launched: readonly LaunchContext[];
  /** Every `audit_events` row the version store recorded (`agent-created`, `agent-changed`, `storage-grant-changed`), oldest first. */
  readonly auditEvents: ReturnType<InMemoryAgentVersionStoreProvider['audits']>;
  /**
   * Starts a run for `starter` and returns its run token: of the Builder, or of `agentId` when it
   * is a seeded agent. With `runId` it adopts the run an approval started (`decide`) instead of
   * creating one.
   */
  start(
    starter: Starter,
    model: string,
    runId?: string,
    agentId?: string,
  ): Promise<{ readonly runId: string; readonly token: string }>;
  /**
   * Saves `body` as a new agent the way the console does, as an Admin: an agent of its own behind
   * the door, with a version a run can pin. `madeBy` records an agent as its creator. Answers its id.
   */
  seedAgent(
    body: AgentVersionBody,
    madeBy?: { readonly agentId: string; readonly version: number; readonly runId: string },
  ): Promise<string>;
  /** The stored row of a seeded or saved agent, or `null`. */
  agent(agentId: string): Promise<AgentRecord | null>;
  /** `POST /api/runs/:id/approval` as the person who started the run; answers the continuation run's id. */
  decide(
    runId: string,
    decision: 'approve' | 'reject',
  ): Promise<{ readonly status: number; readonly runId: string }>;
  /** Every call that reached a Builder port or the run reader, as `port.method`, in order. */
  readonly portCalls: readonly string[];
  /** Ends the run: the run row now reads `completed`, so its token is refused. */
  end(runId: string): void;
  /** Revokes the token in the token registry, as a stop or an expiry sweep does. */
  revoke(token: string): Promise<void>;
  /** Sends one MCP `tools/call` with `token`, as the gateway forwarder would. */
  call(
    token: string,
    name: string,
    args: unknown,
    headers?: Readonly<Record<string, string>>,
    /** The engine's tool-use id; the engine always sets one, so the harness mints one without it. */
    callId?: string,
  ): Promise<ToolAnswer>;
  /**
   * Replays `script` as the run's model; every `aw-control` tool use goes through the door. With
   * `gated`, the harness mirrors the engine gate and the gateway backstop: a tool the Builder
   * requires approval for pauses the run at `awaiting_approval` unless its run was approved for
   * exactly that call, once.
   */
  runScripted(
    token: string,
    model: string,
    options?: {
      gated?: boolean;
      /** The conversation so far; the scripted model's next turn is the count of assistant messages in it. */
      history?: Transcript;
    },
  ): Promise<Transcript>;
}

export interface ToolAnswer {
  /** The HTTP status of the answer: 200 for a tool result, the refusal's status for a bad token. */
  readonly status: number;
  readonly isError: boolean;
  readonly result: Record<string, unknown>;
}

/**
 * The door as production composes it, `builder` feature input included: the workspace switches are
 * installed in the process slot over an in-memory `workspace_features` repository, on for every
 * feature until a test calls `door.workspaceFeatures.replaceDisabled`.
 */
export interface BuilderDoorOptions {
  /** Resolves `WORKSPACE`; a test builds it (`createInMemoryWorkspaceScopeResolver`), as no server module may name core's db. */
  readonly scopes: AuditDeps['scopes'];
  /** The workspace's connectors, when a test seeds them; an empty in-memory store otherwise. */
  readonly connectors?: ConnectorsStoreProvider;
  /**
   * The run store a run's approvals and trials use. A suite builds it (no deployed module may name
   * the in-memory one), and `start` creates its runs in it; without it a run has no approval.
   */
  readonly runStore?: RunStore;
  /** Ports that replace production's, e.g. one that throws; every other port stays production's. */
  readonly override?: Partial<BuilderPorts>;
  /**
   * Wraps the fake run API a trial and an evaluation run through (needs `runStore`), e.g. to make a
   * start throw or an interrupt fail. The approval route still uses the unwrapped one.
   */
  readonly wrapRunApi?: (base: RunApiEnvironment) => RunApiEnvironment;
  /** The agent every started run belongs to, as the door's caller check sees it; the Builder when absent. */
  readonly runAgent?: Pick<AgentRecord, 'name' | 'createdByAgent'>;
  /** The deployment's `AW_DEPLOYMENT_POLICY`, as the door's caller check reads it; none when absent. */
  readonly ceiling?: ProjectPolicy | null;
}
