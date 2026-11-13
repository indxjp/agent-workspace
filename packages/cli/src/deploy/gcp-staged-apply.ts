import { runStep, type DeployContext } from './steps.ts';
import { withPlanFile } from './terraform.ts';

/** The module's resources a first deploy applies before the images can be copied. */
const FOUNDATION_TARGETS = [
  'google_project_service.required',
  'google_artifact_registry_repository.images',
] as const;

/**
 * The Cloud SQL instance, which a first deploy creates while the images copy: it takes 15 to 18
 * minutes and needs none of them. Terraform adds what it depends on (the APIs, the network, the
 * Private Services Access range and connection).
 *
 * Beside it, the Secret Manager key's grant to the Secret Manager service agent, which needs neither
 * an image nor the database. Terraform adds the agent, the 60 s wait for it to propagate and the key.
 * In the full apply that wait held back the master key secret and, through the egress proxy key's
 * `depends_on` (which orders the runner manager even when `sandbox_internet` is off), the runner
 * manager and so web (run 42577620759). Done here, it overlaps the instance's creation. The
 * instance stays first: {@link holdsDatabase} reads it.
 */
const DATABASE_TARGETS = [
  'google_sql_database_instance.main',
  'google_kms_crypto_key_iam_member.secret_manager',
] as const;

/**
 * The first stage of a first deploy: enable the APIs and create the image repository, from a plan
 * file with the rendered variables. This stage is applied without a preview of its own (a departure
 * from ADR-0094): the full plan that follows shows everything it created.
 */
export async function applyFoundation(
  context: DeployContext,
  moduleDirectory: string,
  variablesFile: string,
  targets: readonly string[] = FOUNDATION_TARGETS,
): Promise<void> {
  const chdir = `-chdir=${moduleDirectory}`;
  await withPlanFile(async (planFile) => {
    await runStep(
      context,
      'terraform',
      [
        chdir,
        'plan',
        '-input=false',
        `-var-file=${variablesFile}`,
        ...targets.map((target) => `-target=${target}`),
        `-out=${planFile}`,
      ],
      { show: false },
    );
    await runStep(context, 'terraform', [chdir, 'apply', '-input=false', planFile], {
      show: true,
    });
  });
}

/**
 * Whether the Terraform state already holds the Cloud SQL instance. The whole state is listed:
 * `terraform state list <address>` exits 1 ("Unknown resource") when the address is not in it.
 */
export async function holdsDatabase(
  context: DeployContext,
  moduleDirectory: string,
): Promise<boolean> {
  const listed = await runStep(
    context,
    'terraform',
    [`-chdir=${moduleDirectory}`, 'state', 'list'],
    {
      show: false,
    },
  );
  return listed.stdout.split('\n').some((line) => line.trim() === DATABASE_TARGETS[0]);
}

/** Create the Cloud SQL instance and what it depends on, as {@link applyFoundation} does. */
export function applyDatabase(
  context: DeployContext,
  moduleDirectory: string,
  variablesFile: string,
): Promise<void> {
  return applyFoundation(context, moduleDirectory, variablesFile, DATABASE_TARGETS);
}

/** A step's failure without the copy's "Nothing was applied.", which the targeted apply voids. */
function withoutNothingApplied(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message.replace(/\s*Nothing was applied\.$/gmu, '');
}

/**
 * The slow part of a first deploy, overlapped: `copy` runs while `createDatabase` applies the
 * Cloud SQL instance, and both have settled before this returns, so the full apply starts only
 * after both. The copy prints one line per image and Terraform's output is printed when its command
 * ends, so neither block is interleaved. A failure of either is reported with the other's outcome:
 * the targeted apply may have created resources, so "Nothing was applied." no longer holds.
 *
 * @throws {Error} naming each failed step and what was left applied.
 */
export async function copyWhileCreatingDatabase<T>(
  copy: () => Promise<T>,
  createDatabase: () => Promise<void>,
): Promise<T> {
  const [database, copied] = await Promise.allSettled([createDatabase(), copy()]);
  if (database.status === 'fulfilled' && copied.status === 'fulfilled') return copied.value;
  const rest = 'The rest of the stack was not applied.';
  const databaseReason: unknown = database.status === 'rejected' ? database.reason : undefined;
  const copyReason: unknown = copied.status === 'rejected' ? copied.reason : undefined;
  if (copied.status === 'fulfilled') {
    throw new Error(
      `${withoutNothingApplied(databaseReason)}\nThe release images were copied. ${rest}`,
      { cause: databaseReason },
    );
  }
  if (database.status === 'fulfilled') {
    throw new Error(
      `${withoutNothingApplied(copyReason)}\n` +
        `Cloud SQL and its private network were created while the images copied. ${rest}`,
      { cause: copyReason },
    );
  }
  throw new AggregateError(
    [databaseReason, copyReason],
    `${withoutNothingApplied(databaseReason)}\n${withoutNothingApplied(copyReason)}\n` +
      `The Cloud SQL apply may have created part of its network. ${rest}`,
  );
}
