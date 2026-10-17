/**
 * `@indx-workspace/cli/publish`: the plan-first executors behind `aw platforms publish`
 * (ADR-0133 D11). The CLI reads the files `aw platforms export` wrote and calls the vendor's own
 * tool; it never imports `@indx-workspace/platforms` or a vendor SDK.
 */
import { HOSTED_PLATFORM_IDS, type PlatformId } from '@indx-workspace/contracts/platforms';

import { isMissingTool, spawnTool, type ToolName, type ToolRunner } from '../deploy/runner.ts';
import { awsAgentcore } from './aws-agentcore.ts';
import { claudeManagedAgents } from './claude-managed-agents.ts';
import { copilotStudio } from './copilot-studio.ts';
import { geminiEnterprise } from './gemini-enterprise.ts';
import {
  createPublishRedactor,
  PublishRefusedError,
  versionAtLeast,
  type PublishContext,
  type PublishExecutor,
  type PublishOutcome,
  type PublishPlatformId,
} from './kit.ts';
import { m365DeclarativeAgent } from './m365-declarative-agent.ts';
import { microsoftFoundry } from './microsoft-foundry.ts';

export {
  PublishRefusedError,
  PublishSettingsError,
  type PublishContext,
  type PublishExecutor,
  type PublishOutcome,
  type PublishPlatformId,
  type PublishTool,
} from './kit.ts';

// Total over the hosted ids: a new non-eject platform without an executor fails type-checking.
export const PUBLISH_EXECUTORS: Readonly<Record<PublishPlatformId, PublishExecutor>> = {
  'claude-managed-agents': claudeManagedAgents,
  'm365-declarative-agent': m365DeclarativeAgent,
  'copilot-studio': copilotStudio,
  'microsoft-foundry': microsoftFoundry,
  'gemini-enterprise': geminiEnterprise,
  'aws-agentcore': awsAgentcore,
};

export interface PublishPlatformOptions {
  readonly platform: PlatformId;
  /** The export directory `aw platforms export` wrote (absolute). */
  readonly directory: string;
  /** The root agent the bundle was compiled from. */
  readonly agent: string;
  readonly environment?: string;
  /** `platforms.<id>.environments.<env>` merged over `platforms.<id>.options`. */
  readonly settings: Readonly<Record<string, unknown>>;
  readonly apply: boolean;
  readonly experimental: boolean;
  readonly env?: NodeJS.ProcessEnv;
  /** The suite injects a fake. */
  readonly runner?: ToolRunner;
  /** The suite injects a fake. */
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
  /** Where redacted output goes (stdout when unset). */
  readonly out?: (text: string) => void;
  /** Where redacted error output goes (stderr when unset). */
  readonly err?: (text: string) => void;
}

function hostedPlatform(platform: PlatformId): PublishPlatformId | undefined {
  return HOSTED_PLATFORM_IDS.find((id) => id === platform);
}

/**
 * Plans the publish of an exported bundle and, with `apply`, runs it.
 * @throws {PublishRefusedError} for an eject target;
 * @throws {PublishSettingsError}; @throws {Error} naming the failed vendor step.
 */
export async function publishPlatform(options: PublishPlatformOptions): Promise<PublishOutcome> {
  const platform = hostedPlatform(options.platform);
  if (platform === undefined) {
    throw new PublishRefusedError(
      'eject targets are exported, not published',
      `aw platforms export --platform ${options.platform}`,
    );
  }
  const executor = PUBLISH_EXECUTORS[platform];
  const env = options.env ?? process.env;
  const { redact, conceal } = createPublishRedactor(env);
  const context: PublishContext = {
    platform,
    runner: options.runner ?? spawnTool,
    fetch: options.fetch ?? globalThis.fetch,
    directory: options.directory,
    agent: options.agent,
    env,
    apply: options.apply,
    experimental: options.experimental,
    environment: options.environment ?? executor.defaultEnvironment,
    out: (text) => (options.out ?? ((line) => process.stdout.write(line)))(redact(text)),
    err: (text) => (options.err ?? ((line) => process.stderr.write(line)))(redact(text)),
    conceal,
    signal: options.signal ?? new AbortController().signal,
  };
  return executor.publish(context, options.settings);
}

export interface PublishPrerequisite {
  readonly platform: PublishPlatformId;
  readonly tool: ToolName;
  readonly status: 'pass' | 'fail';
  /** The version found, or the fix. */
  readonly detail: string;
}

/** Runs each vendor tool's version call once: no network and no login probe. */
export async function checkPublishPrerequisites(
  options: {
    readonly platform?: PlatformId;
    readonly env?: NodeJS.ProcessEnv;
    readonly runner?: ToolRunner;
  } = {},
): Promise<readonly PublishPrerequisite[]> {
  const runner = options.runner ?? spawnTool;
  const rows: PublishPrerequisite[] = [];
  for (const platform of HOSTED_PLATFORM_IDS) {
    const executor = PUBLISH_EXECUTORS[platform];
    if (options.platform !== undefined && options.platform !== platform) continue;
    for (const tool of executor.tools) {
      const row = (status: 'pass' | 'fail', detail: string): void => {
        rows.push({ platform, tool: tool.name, status, detail });
      };
      try {
        const result = await runner({
          tool: tool.name,
          args: tool.versionArgs,
          cwd: process.cwd(),
          env: options.env ?? process.env,
        });
        const found = result.stdout.trim().split('\n')[0] ?? '';
        if (result.status !== 0) {
          row('fail', `${tool.name} ${tool.versionArgs.join(' ')} failed; ${tool.install}`);
        } else if (
          tool.minimumVersion !== undefined &&
          versionAtLeast(result.stdout, tool.minimumVersion) !== true
        ) {
          row(
            'fail',
            `${found || 'unknown version'}; needs ${tool.minimumVersion} or later; ${tool.install}`,
          );
        } else {
          row('pass', found);
        }
      } catch (error) {
        if (!isMissingTool(error)) throw error;
        row('fail', `not installed; ${tool.install}`);
      }
    }
  }
  return rows;
}
