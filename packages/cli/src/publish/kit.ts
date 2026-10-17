/**
 * The kit every `aw platforms publish` executor is built from (ADR-0133 D11): vendor tools are
 * spawned through the same `ToolRunner` as `agent-workspace deploy`, every printed line has been
 * through the redactor, and nothing is applied unless the caller asked for it. Credentials are
 * never ours: the vendor CLI reads its own login, and a token an executor fetches is concealed.
 */
import type { HostedPlatformId } from '@indx-workspace/contracts/platforms';
import type { z } from 'zod';

import { createRedactor } from '../deploy/redact.ts';
import {
  isMissingTool,
  type ToolName,
  type ToolResult,
  type ToolRunner,
} from '../deploy/runner.ts';

export type PublishPlatformId = HostedPlatformId;

export interface PublishTool {
  readonly name: ToolName;
  readonly versionArgs: readonly string[];
  /** Semver floor, compared numerically on the first x.y.z in the version output. */
  readonly minimumVersion?: string;
  /** One command line, printed as the fix. */
  readonly install: string;
  readonly docsUrl: string;
}

export interface PublishContext {
  readonly platform: PublishPlatformId;
  readonly runner: ToolRunner;
  readonly fetch: typeof fetch;
  /** The export directory `aw platforms export` wrote (absolute); every tool runs here. */
  readonly directory: string;
  /** The root agent the bundle was compiled from (`aw platforms export`'s `agent`). */
  readonly agent: string;
  readonly env: NodeJS.ProcessEnv;
  readonly apply: boolean;
  readonly experimental: boolean;
  /** The vendor environment/target name (`--env`, else the executor's default). */
  readonly environment: string;
  /** Writes to stdout, redacted. */
  readonly out: (text: string) => void;
  /** Writes to stderr, redacted. */
  readonly err: (text: string) => void;
  /** Adds a secret (a fetched bearer token) to the redactor for the rest of the run. */
  readonly conceal: (secret: string) => void;
  readonly signal: AbortSignal;
}

export interface PublishOutcome {
  readonly changes: boolean;
  readonly applied: boolean;
  readonly nextSteps: readonly string[];
}

export interface PublishExecutor {
  readonly tools: readonly PublishTool[];
  readonly defaultEnvironment: string;
  /** Parses `settings` (`platforms.<id>.environments.<env>` merged over its options) with its own schema. */
  publish(context: PublishContext, settings: unknown): Promise<PublishOutcome>;
}

/** The request cannot be published, and `fix` says what to run instead. */
export class PublishRefusedError extends Error {
  public readonly fix: string | undefined;

  public constructor(message: string, fix?: string) {
    super(message);
    this.name = 'PublishRefusedError';
    this.fix = fix;
  }
}

/** The settings an executor was given do not fit its schema; the message names each path. */
export class PublishSettingsError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'PublishSettingsError';
  }
}

/** Typed construction that erases the settings type behind one validated boundary. */
export function defineExecutor<Settings>(spec: {
  readonly tools: readonly PublishTool[];
  readonly defaultEnvironment: string;
  readonly settingsSchema: z.ZodType<Settings>;
  readonly publish: (context: PublishContext, settings: Settings) => Promise<PublishOutcome>;
}): PublishExecutor {
  return {
    tools: spec.tools,
    defaultEnvironment: spec.defaultEnvironment,
    publish(context, settings) {
      const parsed = spec.settingsSchema.safeParse(settings);
      if (!parsed.success) {
        const prefix = `platforms.${context.platform}.environments.${context.environment}`;
        return Promise.reject(
          new PublishSettingsError(
            parsed.error.issues
              .map((issue) => {
                const segments = [prefix, ...issue.path.map(String)];
                return `${segments.join('.')}: ${issue.message}`;
              })
              .join('\n'),
          ),
        );
      }
      return spec.publish(context, parsed.data);
    },
  };
}

const CREDENTIAL_KEY = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/iu;

/**
 * Every line passes through `createRedactor` over the environment values whose key names a
 * credential; `conceal` adds a secret fetched during the run (a bearer token) to that set.
 */
export function createPublishRedactor(env: NodeJS.ProcessEnv): {
  readonly redact: (text: string) => string;
  readonly conceal: (secret: string) => void;
} {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && CREDENTIAL_KEY.test(key)) masked[key] = value;
  }
  let redactor = createRedactor(masked);
  let concealed = 0;
  return {
    redact: (text) => redactor(text),
    conceal: (secret) => {
      concealed += 1;
      masked[`CONCEALED_${String(concealed)}`] = secret;
      redactor = createRedactor(masked);
    },
  };
}

function withNewline(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}

/** The first `x.y.z` in `text`, as numbers; `null` when there is none. */
function firstVersion(text: string): readonly [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** True when the first `x.y.z` of `output` is at least `minimum`; `null` when `output` has none. */
export function versionAtLeast(output: string, minimum: string): boolean | null {
  const found = firstVersion(output);
  const floor = firstVersion(minimum);
  if (found === null || floor === null) return null;
  for (const [index, part] of found.entries()) {
    const needed = floor[index] ?? 0;
    if (part !== needed) return part > needed;
  }
  return true;
}

function missingToolMessage(tool: PublishTool, platform: string): string {
  return (
    `${tool.name} is not installed or not on PATH: aw platforms publish runs it for ${platform}. ` +
    `Install it: ${tool.install}. Nothing was published.`
  );
}

/** Echo `$ tool args`, run in `context.directory`, accept exit statuses, print output redacted. */
export async function runPublishTool(
  context: PublishContext,
  tool: PublishTool,
  args: readonly string[],
  options: { readonly show?: boolean; readonly accept?: readonly number[] } = {},
): Promise<ToolResult> {
  const { show = true, accept = [0] } = options;
  context.signal.throwIfAborted();
  context.out(`$ ${[tool.name, ...args].join(' ')}\n`);
  let result: ToolResult;
  try {
    result = await context.runner({
      tool: tool.name,
      args,
      cwd: context.directory,
      env: context.env,
    });
  } catch (error) {
    if (!isMissingTool(error)) throw error;
    throw new Error(missingToolMessage(tool, context.platform), { cause: error });
  }
  const accepted = result.status !== null && accept.includes(result.status);
  if (show) context.out(withNewline(result.stdout));
  else if (accepted) context.conceal(result.stdout.trim());
  if (show || !accepted) context.err(withNewline(result.stderr));
  if (!accepted) {
    throw new Error(
      `\`${tool.name} ${args.find((argument) => !argument.startsWith('-')) ?? args.join(' ')}\` failed ` +
        `(${result.status === null ? 'killed by a signal' : `exit status ${String(result.status)}`}); ` +
        'its output is above.',
    );
  }
  return result;
}

/** Runs the tool's version call and refuses when it is older than `minimum` (default: its floor). */
export async function requireTool(
  context: PublishContext,
  tool: PublishTool,
  minimum = tool.minimumVersion,
): Promise<void> {
  const { stdout } = await runPublishTool(context, tool, tool.versionArgs);
  if (minimum === undefined) return;
  const current = versionAtLeast(stdout, minimum);
  if (current === true) return;
  throw new PublishRefusedError(
    current === null
      ? `could not read the ${tool.name} version; aw platforms publish needs ${minimum} or later. Nothing was published.`
      : `${tool.name} is older than ${minimum}, which aw platforms publish needs for ${context.platform}. Nothing was published.`,
    tool.install,
  );
}
