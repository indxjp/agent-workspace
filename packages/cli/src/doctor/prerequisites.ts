/**
 * The tools on `PATH` a profile's target needs, and what this host has of them.
 *
 * Only presence and version are asked — `--version` style, read-only — never whether a daemon or
 * a cluster answers: that is `detectHostCapabilities`' question, and it would make the check
 * depend on the operator's current kubectl context. A tool the target does not need is neither
 * probed nor reported, so a missing one can never fail the run.
 */
import { spawnSync } from 'node:child_process';

import type { CommandProbe, CommandResult } from '../host-capabilities.ts';
import type { DeploymentProfile } from '../profile.ts';
import { helmOverlaySkipReason } from '../render/helm-values.ts';
import type { DoctorCheck } from './checks.ts';

type ToolId = 'docker' | 'compose' | 'kubectl' | 'helm' | 'terraform' | 'vercel' | 'wrangler';

type RequirementLevel = 'required' | 'optional';

interface ToolRequirement {
  readonly tool: ToolId;
  readonly level: RequirementLevel;
  /** Why the profile needs it, as the end of "needed …". */
  readonly reason: string;
}

interface ToolProbe {
  readonly command: string;
  readonly args: readonly string[];
  readonly install: string;
}

const TOOLS: Readonly<Record<ToolId, ToolProbe>> = {
  docker: {
    command: 'docker',
    args: ['--version'],
    install: 'Install Docker Engine or Docker Desktop: https://docs.docker.com/engine/install/',
  },
  compose: {
    command: 'docker',
    args: ['compose', 'version', '--short'],
    install: 'Install the Docker Compose v2 plugin: https://docs.docker.com/compose/install/',
  },
  kubectl: {
    command: 'kubectl',
    args: ['version', '--client'],
    install: 'Install kubectl: https://kubernetes.io/docs/tasks/tools/',
  },
  helm: {
    command: 'helm',
    args: ['version', '--short'],
    install: 'Install Helm 3: https://helm.sh/docs/intro/install/',
  },
  terraform: {
    command: 'terraform',
    args: ['version'],
    install: 'Install Terraform: https://developer.hashicorp.com/terraform/install',
  },
  // Wrangler install and `--version`: https://developers.cloudflare.com/workers/wrangler/install-and-update/
  // (checked 2026-10-08).
  wrangler: {
    command: 'wrangler',
    args: ['--version'],
    install:
      'Install Wrangler (npm install --global wrangler@4.147.0): https://developers.cloudflare.com/workers/wrangler/install-and-update/',
  },
  // Vercel CLI install and `--version`: https://vercel.com/docs/cli (checked 2026-10-08).
  vercel: {
    command: 'vercel',
    args: ['--version'],
    install:
      'Install the Vercel CLI (npm install --global vercel@63.1.0): https://vercel.com/docs/cli',
  },
};

/**
 * The clouds whose profile renders a Terraform module's variables (`render/terraform-vars.ts`).
 * AWS has none — EKS is installed with the chart — and `local` is the Compose project.
 */
const TERRAFORM_CLOUDS: ReadonlySet<string> = new Set(['gcp', 'azure']);

/** Whether the profile renders a chart overlay: a cloud with a chart flavour and a remote bucket. */
function hasChartTarget(profile: DeploymentProfile): boolean {
  return (
    profile.cloud !== 'local' &&
    profile.cloud !== 'vercel' &&
    profile.cloud !== 'cloudflare' &&
    helmOverlaySkipReason(profile) === null
  );
}

function* requirementsOf(profile: DeploymentProfile): Generator<ToolRequirement> {
  if (profile.cloud === 'local') {
    yield { tool: 'docker', level: 'required', reason: 'to run the local Compose project' };
    yield { tool: 'compose', level: 'required', reason: 'to run the local Compose project' };
  }
  if (profile.cloud === 'vercel') {
    yield {
      tool: 'vercel',
      level: 'required',
      reason: 'to configure and deploy the vercel project',
    };
    yield { tool: 'docker', level: 'required', reason: 'to run the database migrations once' };
  }
  if (profile.cloud === 'cloudflare') {
    yield { tool: 'wrangler', level: 'required', reason: 'to deploy the cloudflare Workers' };
    yield { tool: 'docker', level: 'required', reason: 'to run the database migrations once' };
  }
  const hasTerraform = TERRAFORM_CLOUDS.has(profile.cloud);
  if (hasTerraform) {
    yield { tool: 'terraform', level: 'required', reason: `to apply the ${profile.cloud} module` };
  }
  if (hasChartTarget(profile)) {
    // A cloud that also has a Terraform module can be deployed without the chart.
    const level = hasTerraform ? 'optional' : 'required';
    const reason = `to install the ${profile.cloud} chart`;
    yield { tool: 'kubectl', level, reason };
    yield { tool: 'helm', level, reason };
  }
  const runtime = profile.runtime.default;
  if (runtime === 'docker') {
    yield { tool: 'docker', level: 'required', reason: 'by the docker runtime driver' };
  }
  if (runtime === 'kubernetes') {
    yield { tool: 'kubectl', level: 'required', reason: 'by the kubernetes runtime driver' };
  }
}

/** The tools the profile's target needs, once each; a required need outranks an optional one. */
export function requiredTools(profile: DeploymentProfile): readonly ToolRequirement[] {
  const merged = new Map<ToolId, ToolRequirement>();
  for (const requirement of requirementsOf(profile)) {
    const known = merged.get(requirement.tool);
    if (known === undefined || (known.level === 'optional' && requirement.level === 'required')) {
      merged.set(requirement.tool, requirement);
    }
  }
  return [...merged.values()];
}

/** The real probe: runs the command without a shell, and never throws. */
export const runToolCommand: CommandProbe = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
};

/** Only the first version number is reported; the tool's raw output is never printed. */
function versionOf(result: CommandResult): string | null {
  return /\d+\.\d+(?:\.\d+)?/u.exec(`${result.stdout}\n${result.stderr}`)?.[0] ?? null;
}

function describeCommand(probe: ToolProbe): string {
  return [probe.command, ...probe.args].join(' ');
}

function checkTool(requirement: ToolRequirement, command: CommandProbe): DoctorCheck {
  const probe = TOOLS[requirement.tool];
  const base = { check: 'prerequisites', subject: requirement.tool } as const;
  const result = command(probe.command, probe.args);
  if (result.status !== 0) {
    const found =
      result.status === null
        ? `${probe.command} could not be run (not on PATH, or it did not answer)`
        : `\`${describeCommand(probe)}\` exited ${String(result.status)}`;
    return {
      ...base,
      status: requirement.level === 'required' ? 'fail' : 'warn',
      detail: `${found}; it is ${requirement.level === 'required' ? 'needed' : 'optional, used'} ${requirement.reason}`,
      advice: probe.install,
    };
  }
  const version = versionOf(result);
  if (version === null) {
    return {
      ...base,
      status: 'warn',
      detail: `found, but \`${describeCommand(probe)}\` printed no version`,
      advice: `Check that ${probe.command} on PATH is the real tool. ${probe.install}`,
    };
  }
  if (requirement.tool === 'compose' && Number(version.split('.')[0]) < 2) {
    return {
      ...base,
      status: 'warn',
      detail: `Compose ${version} is older than v2`,
      advice: probe.install,
    };
  }
  return { ...base, status: 'pass', detail: version, advice: null };
}

/** One result per tool the target needs, each probed once through `command`. */
export function checkPrerequisites(
  profile: DeploymentProfile,
  command: CommandProbe,
): readonly DoctorCheck[] {
  const requirements = requiredTools(profile);
  if (requirements.length === 0) {
    return [
      {
        check: 'prerequisites',
        subject: 'tools',
        status: 'pass',
        detail: `the ${profile.cloud} target needs no tool on PATH`,
        advice: null,
      },
    ];
  }
  return requirements.map((requirement) => checkTool(requirement, command));
}
