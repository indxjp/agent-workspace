/**
 * `agent-workspace deploy [dir] [--yes] [--target helm|terraform|vercel|cloudflare] [--infra <dir>]` — take an
 * edited profile to the running deployment (ADR-0094).
 *
 * `deploy` re-renders the project first, with `render` itself, so a refused profile stops it
 * before any tool runs. It then drives the real tool for the profile's target — Docker Compose,
 * Helm, Terraform, the Vercel CLI or Wrangler — prints that tool's plan, and applies only with `--yes`. Without `--yes`
 * nothing is deployed, and the outcome is the exit code: 0 when the deployment matches, 2 when
 * there are changes, as `terraform plan -detailed-exitcode` reports it; a refusal is 1.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { refusalText } from '../cli-failure.ts';
import {
  assertComposeProjectName,
  parseEnvironment,
  type DeploymentImages,
} from '../deployment.ts';
import { parseProfileDocument, type DeploymentProfile } from '../profile.ts';
import { ENV_IMAGE_KEYS } from '../render/env.ts';
import { runRenderCommand } from '../render.ts';
import { deployWithCompose } from './compose.ts';
import { deployWithHelm } from './helm.ts';
import { createRedactor } from './redact.ts';
import { spawnTool, type ToolRunner } from './runner.ts';
import type { DeployContext, DeployOutcome } from './steps.ts';
import {
  assertTargetPresent,
  REQUESTED_TARGETS,
  selectTarget,
  type DeployTarget,
  type RequestedTarget,
} from './targets.ts';
import { CLOUDFLARE_API_TOKEN_VARIABLE, deployWithCloudflare } from './cloudflare.ts';
import { deployWithTerraform } from './terraform.ts';
import { deployWithVercel, VERCEL_TOKEN_VARIABLE } from './vercel.ts';

const USAGE =
  'Usage: agent-workspace deploy [dir] [--yes] [--target helm|terraform|vercel|cloudflare] [--infra <dir>]';

/** The exit code of a plan with changes that `--yes` was not given to apply. */
export const DEPLOY_CHANGES_PENDING = 2;

export interface DeployCommandArguments {
  readonly directory: string;
  readonly apply: boolean;
  readonly target: RequestedTarget | null;
  readonly infraDirectory: string | null;
}

function isRequestedTarget(value: string): value is RequestedTarget {
  return (REQUESTED_TARGETS as readonly string[]).includes(value);
}

/**
 * Parse the arguments. An unknown flag is refused rather than ignored: `--yse` silently dropped
 * would print a plan the operator believes was applied.
 */
export function parseDeployArguments(argv: readonly string[]): DeployCommandArguments {
  let directory: string | null = null;
  let apply = false;
  let target: RequestedTarget | null = null;
  let infraDirectory: string | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (argument === '--yes' || argument === '-y') {
      apply = true;
    } else if (argument === '--target' || argument === '--infra') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`${argument} needs a value. ${USAGE}`);
      }
      index += 1;
      if (argument === '--infra') {
        infraDirectory = path.resolve(value);
      } else if (isRequestedTarget(value)) {
        target = value;
      } else {
        throw new Error(
          `--target must be helm, terraform, vercel or cloudflare; got ${JSON.stringify(value)}. ${USAGE}`,
        );
      }
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option ${JSON.stringify(argument)}. ${USAGE}`);
    } else if (directory === null) {
      directory = argument;
    } else {
      throw new Error(`Unexpected extra argument ${JSON.stringify(argument)}. ${USAGE}`);
    }
  }
  return { directory: path.resolve(directory ?? process.cwd()), apply, target, infraDirectory };
}

export interface RunDeployCommandOptions {
  /** Runs `docker`, `helm` and `terraform`; the suite injects a stub. */
  readonly runner?: ToolRunner;
  /** The tools' environment, and where `render` reads `AW_<NAME>_IMAGE`; production reads `process.env`. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Probes the deployed control plane; production uses the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Overrides how long the control plane is waited for, so a suite does not wait minutes. */
  readonly readiness?: DeployContext['readiness'];
  /** Overrides the waits between a Cloudflare Worker step's retries, so a suite does not wait seconds. */
  readonly workerRetryDelaysMs?: DeployContext['workerRetryDelaysMs'];
}

/**
 * The images `.env` pins, which `render` has just written. Only the names of the module and the
 * chart flavour are read from what they render, so no registry is consulted.
 */
function pinnedImages(environment: Readonly<Record<string, string>>): DeploymentImages {
  return {
    web: environment[ENV_IMAGE_KEYS.web] ?? '',
    gateway: environment[ENV_IMAGE_KEYS.gateway] ?? '',
    runner: environment[ENV_IMAGE_KEYS.runner] ?? '',
    runtime: environment[ENV_IMAGE_KEYS.runtime] ?? '',
  };
}

/**
 * `render` rewrites only the image lines of `.env`, so after the profile's runtime changes (to E2B,
 * say) `.env` still names the driver it was created with. The Vercel and Cloudflare targets send
 * `RUNTIME_DRIVER` to the runner manager and require what that driver needs (the sandbox bridge
 * URL), so the profile, the file `render` just re-read, decides it.
 */
function withProfileRuntime(
  dotEnv: Readonly<Record<string, string>>,
  profile: DeploymentProfile,
): Readonly<Record<string, string>> {
  if (profile.cloud !== 'vercel' && profile.cloud !== 'cloudflare') return dotEnv;
  const driver = profile.runtime.default;
  const needsProvider = driver === 'external' && (dotEnv['EXTERNAL_PROVIDER']?.trim() ?? '') === '';
  return {
    ...dotEnv,
    RUNTIME_DRIVER: driver,
    ...(needsProvider ? { EXTERNAL_PROVIDER: profile.runtime.provider ?? 'e2b' } : {}),
  };
}

function runTarget(
  context: DeployContext,
  target: DeployTarget,
  project: () => string,
  dotEnv: Readonly<Record<string, string>>,
  apply: boolean,
): Promise<DeployOutcome> {
  switch (target.kind) {
    case 'compose':
      return deployWithCompose(context, project(), apply);
    case 'helm':
      return deployWithHelm(context, target, apply);
    case 'terraform':
      return deployWithTerraform(context, target, apply);
    case 'vercel':
      return deployWithVercel(context, target, dotEnv, apply);
    case 'cloudflare':
      return deployWithCloudflare(context, target, dotEnv, apply);
  }
}

/** `agent-workspace deploy`. Resolves with what the plan found and whether it was applied. */
export async function runDeployCommand(
  argv: readonly string[] = [],
  options: RunDeployCommandOptions = {},
): Promise<DeployOutcome> {
  const { directory, apply, target: requested, infraDirectory } = parseDeployArguments(argv);
  const environment = options.environment ?? process.env;

  // `render`'s own output is held until the redactor that knows `.env` exists, like a tool's.
  const rendered: { readonly stream: 'out' | 'err'; readonly text: string }[] = [];
  const printRendered = (redact: (text: string) => string) => {
    for (const { stream, text } of rendered.splice(0)) {
      (stream === 'out' ? process.stdout : process.stderr).write(redact(text));
    }
  };
  try {
    await runRenderCommand([directory], {
      environment,
      out: (text) => rendered.push({ stream: 'out', text }),
      err: (text) => rendered.push({ stream: 'err', text }),
    });
  } catch (error) {
    // A refused profile may quote a store URL; its password is masked like any other output.
    const redact = createRedactor({});
    printRendered(redact);
    throw new Error(redact(refusalText(error)), { cause: error });
  }

  const profileText = await readFile(path.join(directory, 'agent-workspace.yaml'), 'utf8');
  const profile = parseProfileDocument(profileText);
  // `render` has just refused any malformed line, so this read cannot quote one.
  const dotEnv = parseEnvironment(await readFile(path.join(directory, '.env'), 'utf8'));
  // The cloud tokens are the process's, not `.env`'s, so they are masked by name here.
  const processTokens = Object.fromEntries(
    [VERCEL_TOKEN_VARIABLE, CLOUDFLARE_API_TOKEN_VARIABLE].flatMap((name) => {
      const value = environment[name]?.trim() ?? '';
      return value === '' ? [] : [[name, value]];
    }),
  );
  const redact = createRedactor({ ...dotEnv, ...processTokens }, profileText);
  printRendered(redact);
  const target = selectTarget({
    profile,
    images: pinnedImages(dotEnv),
    requested,
    projectDirectory: directory,
    infraDirectory,
  });
  await assertTargetPresent(target);

  const context: DeployContext = {
    runner: options.runner ?? spawnTool,
    directory,
    env: environment,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.readiness === undefined ? {} : { readiness: options.readiness }),
    ...(options.workerRetryDelaysMs === undefined
      ? {}
      : { workerRetryDelaysMs: options.workerRetryDelaysMs }),
    cloud: profile.cloud,
    out: (text) => void process.stdout.write(redact(text)),
    err: (text) => void process.stderr.write(redact(text)),
  };
  // A plan is labelled as one: it applies nothing (BH061-027).
  context.out(
    `${apply ? 'Deploying' : 'Planning'} ${directory} (cloud ${profile.cloud}) with ${target.kind}.\n`,
  );
  const outcome = await runTarget(
    context,
    target,
    () => assertComposeProjectName(dotEnv['COMPOSE_PROJECT_NAME']),
    withProfileRuntime(dotEnv, profile),
    apply,
  );

  if (!outcome.changes) {
    context.out('No changes: the deployment matches agent-workspace.yaml.\n');
  } else if (outcome.applied) {
    context.out('Applied.\n');
  } else {
    context.out('Changes are pending; nothing was applied. Re-run with --yes to apply them.\n');
  }
  return outcome;
}
