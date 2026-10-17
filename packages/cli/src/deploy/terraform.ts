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

export async function deployWithTerraform(
  context: DeployContext,
  target: TerraformTarget,
  apply: boolean,
): Promise<DeployOutcome> {
  const chdir = `-chdir=${target.moduleDirectory}`;
  const planDirectory = await mkdtemp(path.join(os.tmpdir(), 'agent-workspace-deploy-'));
  const planFile = path.join(planDirectory, 'plan.tfplan');
  const detach = removeOnInterrupt(planDirectory);
  try {
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
    const changes = plan.status === 2;
    if (!apply || !changes) return { changes, applied: false };
    await runStep(context, 'terraform', [chdir, 'apply', '-input=false', planFile], {
      show: true,
    });
    return { changes, applied: true };
  } finally {
    detach();
    await rm(planDirectory, { recursive: true, force: true });
  }
}
