import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import type { RunAgent } from '../agent-versions/session-version';
import type { AgentRecord } from '../agents/contract';
import type { AgentStoreProvider } from '../agents/store';
import type { DeploymentDefaultModels, ModelDiscovery, ModelsStoreProvider } from '../integrations';
import type {
  ModelSelection,
  RunTargetDescriptions,
  RuntimeProfileStoreProvider,
} from '../execution';
import type { AgentRunResourceLoader } from './resource-loader';
import type { ModelResolution } from './run-request';
import type { RunStartRefusal } from './run-start-refusal';

export interface RunPreflightDependencies {
  readonly agents: AgentStoreProvider;
  readonly profiles: RuntimeProfileStoreProvider;
  /** `null` when encrypted model storage is unavailable; then no model can resolve. */
  readonly models: {
    readonly models: ModelsStoreProvider;
    readonly discover: ModelDiscovery;
  } | null;
  readonly workspaceDefault: (workspaceId: string) => Promise<ModelSelection | null>;
  /** The project default of the project `sessionId` is filed under, or `null`. */
  readonly projectDefault: (
    workspaceId: string,
    sessionId: string,
  ) => Promise<ModelSelection | null>;
  /**
   * The default of every active project that sets one, by project id: what
   * {@link RunPreflight.describe} needs to say what a run would use in each project the composer
   * can select.
   */
  readonly projectDefaults: (workspaceId: string) => Promise<ReadonlyMap<string, ModelSelection>>;
  /**
   * The deployment's default model id per provider (`AW_DEPLOYMENT_DEFAULT_MODELS`, issue #506),
   * parsed once at startup: the ladder's last layer, for an agent that names no model. Empty when
   * the deployment sets none, which is a refusal naming `deployment`.
   */
  readonly deploymentDefaultModels: DeploymentDefaultModels;
  /**
   * The deployment's policy ceiling (`AW_DEPLOYMENT_POLICY`), or `null` for none (S2-04c). An engine
   * or a ladder-resolved model outside it refuses the run with `policy_cannot_widen`.
   */
  readonly policyCeiling: ProjectPolicy | null;
  /**
   * What the run's files total is read from (the storage design, §04): absent, the total is judged
   * only when the run launches.
   */
  readonly runFiles?: RunFilesSources;
  readonly warn?: (message: string) => void;
}

/** The reads behind the files total {@link RunPreflight.check} judges before a run is queued. */
export interface RunFilesSources {
  /** A loader created with `sizesOnly`: catalog row sizes, never bytes. */
  readonly loader: AgentRunResourceLoader;
  /** The configuration a run composes from: version `agentVersionId`, or the row for `null`. */
  readonly readRunAgent: (
    workspaceId: string,
    agentId: string,
    agentVersionId: string | null,
  ) => Promise<RunAgent>;
  /** The project session `sessionId` is filed under, or `null`. */
  readonly projectOf: (workspaceId: string, sessionId: string) => Promise<string | null>;
}

/** The files of a run about to be queued, for the total {@link RunPreflight.check} judges. */
export interface RunFilesQuery {
  /** The version the run will compose from, or `null` for an agent row (a legacy session). */
  readonly agentVersionId: string | null;
  readonly attachments: readonly { readonly fileId: string }[];
  readonly fileScope?: readonly string[];
}

export interface RunModelQuery {
  readonly workspaceId: string;
  readonly agentId: string;
  /**
   * The session the run continues, or `null` for a run that will open a new one. A new session
   * opened by `runs.start` belongs to no project (the start-run body carries none), so it has no
   * project default.
   */
  readonly sessionId: string | null;
  readonly modelOverride: ModelSelection | null;
  /**
   * The configuration the run composes from, when the caller has read it: a session's pinned
   * version (issue #612). Absent reads the agent row.
   */
  readonly agent?: AgentRecord;
  /** How many workspace files the run attaches (ADR-0146). Absent means none. */
  readonly attachmentCount?: number;
  /** How many of those are audio files (issue #1313); only a transcribing provider takes one. */
  readonly audioAttachmentCount?: number;
  /** The run's files, for the files total; absent, the total is judged when the run launches. */
  readonly files?: RunFilesQuery;
}

export interface RunPreflight {
  /** The run's model, resolved through the documented ladder. */
  resolveModel(query: RunModelQuery): Promise<ModelResolution>;
  /** `null` when the run can be queued; otherwise the first missing piece. */
  check(query: RunModelQuery): Promise<RunStartRefusal | null>;
  /**
   * What a new run of this agent would use, for a screen to show before anything is sent, or
   * `null` when the agent does not exist. It follows the run ladder below the run override: the
   * agent's own model, then the selected project's default, then the workspace default, then the
   * deployment default for the agent's connection (or the workspace's connection named `default`
   * when the agent names none). It reads
   * stored configuration only, with no provider call, so it is cheap enough for every agent on a
   * page; the run itself still validates the model.
   */
  describe(workspaceId: string, agentId: string): Promise<RunTargetDescriptions | null>;
}
