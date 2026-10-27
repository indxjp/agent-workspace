import type { BuilderToolName, BuilderToolOutputs } from '@indx-workspace/contracts/builder';

import type { ToolCall } from '../core/call';
import type { Facts } from '../core/facts';
import type {
  AgentStorePort,
  ApprovalPort,
  AuditPort,
  AuthorizationPort,
  CallContext,
  CatalogPort,
  CheckerPort,
  PolicyPort,
  RunnerPort,
} from '../ports';

/** Whether the Builder is switched on for the call's workspace (the `builder` feature, #1846 slice 3). */
interface FeatureSwitch {
  enabled(ctx: CallContext): Promise<boolean>;
}

/** Every port the shell reads, built once by the composition root (or by a test, in memory). */
export type BuilderPorts = {
  readonly feature: FeatureSwitch;
  readonly approval: ApprovalPort;
  readonly authorization: AuthorizationPort;
  readonly policy: PolicyPort;
  readonly checker: CheckerPort;
  readonly store: AgentStorePort;
  readonly runner: RunnerPort;
  readonly catalog: CatalogPort;
  readonly audit: AuditPort;
  /** The only clock the Builder reads, so the quota's UTC day is fixed in a test and never read by the core. */
  readonly clock: () => Date;
};

/** An expected failure, returned and never thrown (design §08 Errors rule 1). */
export type ToolFailure = {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly details?: readonly string[];
  readonly fix?: string;
};

/** What the model sees for one call; `truncated` (in each output schema) marks a cut result. */
export type ToolResult =
  BuilderToolOutputs[BuilderToolName] | (ToolFailure & { readonly truncated?: true });

export type CallOf<K extends BuilderToolName> = Extract<ToolCall, { readonly tool: K }>;

/** Turns a call the core decided to `run` into port calls and the tool's output. */
export type Executor<K extends BuilderToolName> = (
  call: CallOf<K>,
  ctx: CallContext,
  ports: BuilderPorts,
  creator: Facts['creator'],
) => Promise<BuilderToolOutputs[K] | ToolFailure>;

export type Executors = { readonly [K in BuilderToolName]: Executor<K> };
