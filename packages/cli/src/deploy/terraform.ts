/**
 * `deploy` for a Terraform target (ADR-0094).
 *
 * `terraform plan -out` writes the plan `deploy` prints to a file, and `--yes` applies that file,
 * so what is applied is exactly what was shown — never a fresh plan computed after the operator
 * read the first one. The rendered variables are passed with `-var-file` where they lie in the
 * project, so a stale copy in the module cannot win. A plan file holds variable values in plain
 * text: it lives in a directory only this user can read (`mkdtemp` creates it `0700`) and is
 * removed when the command ends, applied or not — interrupted by Ctrl-C or `SIGTERM` included.
 */
import { rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runStep, type DeployContext, type DeployOutcome } from './steps.ts';
import type { DeployTarget } from './targets.ts';

type TerraformTarget = Extract<DeployTarget, { kind: 'terraform' }>;

const INTERRUPTING_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

/**
 * Remove `directory` if the process is interrupted while it exists: a signal ends the process
 * without running `finally`, which would leave the plan file's plain-text variables behind. The
 * listener removes itself and re-raises the signal, so the exit status stays the signal's (130
 * or 143). Returns the function that detaches the listeners once `finally` has the directory.
 */
function removeOnInterrupt(directory: string): () => void {
  function detach(): void {
    for (const signal of INTERRUPTING_SIGNALS) process.off(signal, onSignal);
  }
  function onSignal(signal: NodeJS.Signals): void {
    detach();
    try {
      rmSync(directory, { recursive: true, force: true });
    } finally {
      process.kill(process.pid, signal);
    }
  }
  for (const signal of INTERRUPTING_SIGNALS) process.once(signal, onSignal);
  return detach;
}

/**
 * Run `use` with the path of a plan file in a directory only this user can read, removed when it
 * ends, applied or not, or when the process is interrupted. Every plan file this CLI writes goes
 * through here, so none outlives its command.
 */
export async function withPlanFile<T>(use: (planFile: string) => Promise<T>): Promise<T> {
  const planDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-deploy-'));
  const detach = removeOnInterrupt(planDirectory);
  try {
    return await use(path.join(planDirectory, 'plan.tfplan'));
  } finally {
    detach();
    await rm(planDirectory, { recursive: true, force: true });
  }
}

/** An action of a `terraform show -json` change that leaves the infrastructure as it is. */
const UNCHANGING_ACTIONS: ReadonlySet<unknown> = new Set(['no-op', 'read']);

function changeChanges(entry: unknown): boolean {
  if (typeof entry !== 'object' || entry === null) return false;
  const change: unknown = 'change' in entry ? entry.change : entry;
  if (typeof change !== 'object' || change === null || !('actions' in change)) return false;
  const actions: unknown = change.actions;
  return Array.isArray(actions) && actions.some((action) => !UNCHANGING_ACTIONS.has(action));
}

/**
 * Whether the plan `terraform show -json <planfile>` printed would change anything: its
 * `applyable` (Terraform 1.6 and later), else any resource or output change that is not a no-op.
 *
 * @throws {Error} when the text is not a plan, so an unreadable plan is never taken as empty.
 */
function planHasChanges(planJson: string): boolean {
  let plan: unknown;
  try {
    plan = JSON.parse(planJson);
  } catch (error) {
    throw new Error('`terraform show -json` did not print a plan. Nothing was applied.', {
      cause: error,
    });
  }
  if (typeof plan !== 'object' || plan === null || !('format_version' in plan)) {
    throw new Error('`terraform show -json` did not print a plan. Nothing was applied.');
  }
  if ('applyable' in plan && typeof plan.applyable === 'boolean') return plan.applyable;
  const resources: unknown = 'resource_changes' in plan ? plan.resource_changes : [];
  const outputs: unknown = 'output_changes' in plan ? plan.output_changes : {};
  return (
    (Array.isArray(resources) && resources.some(changeChanges)) ||
    (typeof outputs === 'object' && outputs !== null && Object.values(outputs).some(changeChanges))
  );
}

/**
 * Plan, and with `apply` apply that plan. `afterPlan` is called with the plan file as soon as it is
 * written, so a caller can summarise exactly the plan that is about to be applied.
 */
export function deployWithTerraform(
  context: DeployContext,
  target: TerraformTarget,
  apply: boolean,
  afterPlan?: (planFile: string) => Promise<void>,
): Promise<DeployOutcome> {
  const chdir = `-chdir=${target.moduleDirectory}`;
  return withPlanFile(async (planFile) => {
    const plan = await runStep(
      context,
      'terraform',
      [
        chdir,
        'plan',
        '-input=false',
        '-detailed-exitcode',
        `-var-file=${target.variablesFile}`,
        `-out=${planFile}`,
      ],
      { show: true, accept: [0, 2] },
    );
    // Exit status 2 is a plan with changes. A 0 is confirmed from the plan file, because a
    // wrapper such as setup-terraform's `terraform_wrapper` exits 0 for Terraform's 2: trusting
    // it once applied nothing while the deploy reported "No changes".
    const changes =
      plan.status === 2 ||
      planHasChanges(
        (await runStep(context, 'terraform', [chdir, 'show', '-json', planFile], { show: false }))
          .stdout,
      );
    if (changes) await afterPlan?.(planFile);
    if (!apply || !changes) return { changes, applied: false };
    await runStep(context, 'terraform', [chdir, 'apply', '-input=false', planFile], {
      show: true,
    });
    return { changes, applied: true };
  });
}
