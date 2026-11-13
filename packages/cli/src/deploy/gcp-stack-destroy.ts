import { lifecycleStep, type StepReport } from './gcp-lifecycle-step.ts';
import { protectedDeletions, showPlanSummary } from './gcp-plan.ts';
import { runStep, type DeployContext } from './steps.ts';
import { withPlanFile } from './terraform.ts';

const DATA_PROTECTION =
  /deletion_protection|deletion protection|prevent_destroy|cannot be destroyed/iu;

/** What to tell the Owner when Terraform refuses to delete protected data. */
const DATA_PROTECTION_ADVICE =
  'To delete this stack and its data, set environments.production.gcp.dataProtection: false in ' +
  'agent-workspace.yaml, run aw deploy production --yes, then run aw deploy destroy production again.';

/** What Terraform says when Google Cloud still holds the network after the services are gone. */
const NETWORK_IN_USE = /resourceInUseByAnotherResource|is already being used by/u;

const NETWORK_RELEASE_NOTICE =
  'Google Cloud releases the network 1–2 hours after its services are deleted; everything else ' +
  'is gone. Run aw deploy destroy production again after that.';

/** Google Cloud keeps what a destroy cannot delete, and the module names it after the project. */
const REDEPLOY_NOTICE =
  'Destroyed. This project name cannot be deployed again in this Google Cloud project right away: ' +
  'Google Cloud keeps the KMS key ring and reserves the Cloud SQL instance name for about a week. ' +
  'To deploy sooner, rename the project in agent-workspace.yaml.';

interface DestroyStack {
  readonly moduleDirectory: string;
  readonly variablesFile: string;
  readonly project: string;
  readonly confirm: (question: string) => Promise<string>;
}

const DESTROY_REPORT: StepReport = {
  rerun: 'aw deploy destroy production',
  advise: (stderr) => {
    if (DATA_PROTECTION.test(stderr)) {
      return `Data protection is on, so Terraform will not delete protected data. ${DATA_PROTECTION_ADVICE}`;
    }
    return NETWORK_IN_USE.test(stderr) ? NETWORK_RELEASE_NOTICE : undefined;
  },
};

async function planDestruction(
  context: DeployContext,
  stack: DestroyStack,
  planFile: string,
): Promise<string> {
  await runStep(
    context,
    'terraform',
    [
      `-chdir=${stack.moduleDirectory}`,
      'plan',
      '-destroy',
      '-input=false',
      `-var-file=${stack.variablesFile}`,
      `-out=${planFile}`,
    ],
    { show: false },
  );
  return showPlanSummary(context, stack.moduleDirectory, planFile);
}

async function confirmDestruction(stack: DestroyStack, planJson: string): Promise<void> {
  const protectedLabels = protectedDeletions(planJson);
  if (protectedLabels.length > 0) {
    throw new Error(
      `Data protection is on, so nothing was destroyed: ${protectedLabels.join(', ')}. ${DATA_PROTECTION_ADVICE}`,
    );
  }
  const typed = (
    await stack.confirm('Type the Google Cloud project id to delete everything')
  ).trim();
  if (typed !== stack.project) {
    throw new Error(`"${typed}" is not the project id ${stack.project}. Nothing was destroyed.`);
  }
}

/**
 * Plan the destruction, reject protected resources and apply only after the Owner types the
 * Google Cloud project id. Both lifecycle steps report how to safely repeat a failed destroy.
 */
export async function destroyStack(context: DeployContext, stack: DestroyStack): Promise<void> {
  await withPlanFile(async (planFile) => {
    const planJson = await lifecycleStep(
      context,
      'Plan the destruction',
      (step) => planDestruction(step, stack, planFile),
      DESTROY_REPORT,
    );
    await confirmDestruction(stack, planJson);
    await lifecycleStep(
      context,
      'Destroy the stack',
      (step) =>
        runStep(
          step,
          'terraform',
          [`-chdir=${stack.moduleDirectory}`, 'apply', '-input=false', planFile],
          { show: true },
        ),
      DESTROY_REPORT,
    );
    context.out(`${REDEPLOY_NOTICE}\n`);
  });
}
