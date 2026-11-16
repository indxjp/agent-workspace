import { type AgentVersionBody } from '@indx-workspace/contracts/agent-versions';
import type { EngineId } from '@indx-workspace/contracts/engines';
import * as define from '@indx-workspace/sdk/define';
import { type PortableAgentContext } from '@indx-workspace/sdk/portable';
import { type CliIo } from '../io.js';
import { type ProjectProblem } from './problems.js';

/** `process.features`, or what a test puts in its place. */
export interface LoaderFeatures {
  readonly typescript: string | false;
}

export interface LoadProjectOptions {
  /** The project's directory, absolute. */
  readonly root: string;
  readonly io: CliIo;
  readonly signal: AbortSignal;
  readonly features?: LoaderFeatures | undefined;
  readonly timeoutMs?: number | undefined;
  /** The project file's `engine`, for an agent that names none (C12). */
  readonly defaultEngine?: EngineId | undefined;
  /** More variables to keep out of the child: the project's secret names (SD17). */
  readonly withheld?: readonly string[] | undefined;
  /** The project file's `models`, which an `.agent.md` model is matched to (ADR-0166 D12). */
  readonly models?: PortableAgentContext['models'];
  /**
   * Whether `agents/*.agent.md` files are read as agents (ADR-0166 D12); default `true`. Only
   * `aw platforms`, which reads them itself through the SDK without converting, turns it off.
   */
  readonly agentMarkdown?: boolean | undefined;
}

/** One agent the project defines, with its surfaces, ready to be checked or saved. */
export interface LoadedAgent {
  readonly file: string;
  readonly name: string;
  readonly body: AgentVersionBody;
  /** The file of each of `body.surfaces`, in the same order. */
  readonly surfaceFiles: readonly string[];
  /** The code tools (ADR-0115) this agent lists. */
  readonly codeTools: readonly LoadedCodeTool[];
}

/** One catalog tool of the project (C15), with the file that declares it. */
export interface LoadedTool {
  /** The module that exports the tool, or the agent's file for an inline one. */
  readonly file: string;
  readonly definition: define.ToolDefinition;
}

/** One code tool of the project (`defineTool()`, ADR-0115): served by the tool host, not stored. */
export interface LoadedCodeTool {
  readonly file: string;
  readonly name: string;
  /** The project-relative run file the tool declares; `aw push` bundles it (ADR-0118 TS1). */
  readonly run: string;
  /** What `aw push` pins beside the bundle's digest for a hosted tool sandbox (ADR-0118 TS4). */
  readonly pinned?: define.PinnedToolDeclaration;
}

/** What the loader found: the agents that loaded cleanly, and every problem. */
export interface ProjectLoad {
  readonly agents: readonly LoadedAgent[];
  readonly problems: readonly ProjectProblem[];
  /** The secret names the loaded agents' tools reference, each once, sorted (SD17). */
  readonly secrets: readonly string[];
  /** The loaded agents' `openapiTool()` and `postgresTool()` tools, each name once. */
  readonly tools: readonly LoadedTool[];
  /** The loaded agents' `defineTool()` tools, each name once. */
  readonly codeTools: readonly LoadedCodeTool[];
}
