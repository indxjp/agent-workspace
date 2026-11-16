import type { ToolResult } from './runner.ts';
import { runStep, type DeployContext } from './steps.ts';
import { type Part } from './vercel-parts.ts';

export const ENVIRONMENT = 'production';

/**
 * The variables Vercel stores as Sensitive: write-only after creation (ADR-0120 clause 8). The
 * master key is the one that matters most; the rest are every other credential `.env` renders.
 */
const SENSITIVE_VARIABLES: ReadonlySet<string> = new Set([
  'MASTER_ENCRYPTION_KEY',
  'SESSION_SECRET',
  'GATEWAY_TOKEN_SECRET',
  'CRON_SECRET',
  'BOOTSTRAP_ADMIN_PASSWORD',
  'RUNNER_MANAGER_TOKEN',
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'DATABASE_URL',
  'OIDC_CLIENT_SECRET',
]);

/** The names `vercel env ls` lists: the first column of each row. */
function listedNames(listing: string): ReadonlySet<string> {
  return new Set(
    listing
      .split(/\r?\n/u)
      .map((line) => line.trim().split(/\s+/u)[0] ?? '')
      .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)),
  );
}

// Vercel CLI 63.1.0 answers `Error: There is no project for "<name>"` with exit 1 (observed in the
// lightweight-journey run 37897406759, 2026-10-09); `project inspect` has no structured form, so
// the wording is matched.
const PROJECT_NOT_FOUND =
  /not found|does not exist|no such project|there is no project for "[^"\r\n]*"/iu;

async function projectExists(
  context: DeployContext,
  project: string,
  team: string,
): Promise<boolean> {
  const result: ToolResult = await runStep(
    context,
    'vercel',
    ['project', 'inspect', project, '--scope', team],
    { show: false, accept: [0, 1] },
  );
  if (result.status === 0) return true;
  if (PROJECT_NOT_FOUND.test(`${result.stdout}\n${result.stderr}`)) return false;
  // Anything else (a rejected token, no network) is not "the project is missing".
  context.err(result.stderr);
  throw new Error(
    `\`vercel project inspect\` failed (exit status ${String(result.status)}) and did not say the ` +
      'project is missing; its output is above. Nothing was applied.',
  );
}

export const linkedTo = (team: string, project: string) => ({
  VERCEL_ORG_ID: team,
  VERCEL_PROJECT_ID: project,
});

export interface PartState {
  readonly exists: boolean;
  readonly missing: readonly (readonly [string, string])[];
}

export async function inspectPart(
  context: DeployContext,
  part: Part,
  team: string,
): Promise<PartState> {
  const exists = await projectExists(context, part.project, team);
  const present = exists
    ? listedNames(
        (
          await runStep(context, 'vercel', ['env', 'ls', ENVIRONMENT, '--scope', team], {
            show: false,
            env: linkedTo(team, part.project),
          })
        ).stdout,
      )
    : new Set<string>();
  const missing = part.variables.filter(([name]) => !present.has(name));
  const kept = part.variables.filter(([name]) => present.has(name)).map(([name]) => name);

  context.out(
    `Vercel project ${part.project} (${part.label}, team ${team}): ` +
      (exists ? 'exists' : 'will be created') +
      `; ${String(missing.length)} of ${String(part.variables.length)} ${ENVIRONMENT} ` +
      'variable(s) to add' +
      (missing.length === 0 ? '.\n' : `: ${missing.map(([name]) => name).join(', ')}.\n`),
  );
  // Vercel never returns a Sensitive value, so a changed value cannot be told from an unchanged
  // one. Say so rather than keep a stale secret without a word.
  if (kept.length > 0) {
    context.out(
      `Left as they are in ${part.project} (their values are not compared): ${kept.join(', ')}.\n` +
        `To change one, remove it with \`vercel env rm <NAME> production\` in ${part.project}, then deploy again.\n`,
    );
  }
  return { exists, missing };
}

export async function configurePart(
  context: DeployContext,
  part: Part,
  team: string,
  state: PartState,
): Promise<void> {
  if (!state.exists) {
    await runStep(context, 'vercel', ['project', 'add', part.project, '--scope', team], {
      show: true,
    });
  }
  // Before the variables, so a refused request leaves none of them written.
  await setRootDirectory(context, part, team);
  for (const [name, value] of state.missing) {
    await runStep(
      context,
      'vercel',
      [
        'env',
        'add',
        name,
        ENVIRONMENT,
        SENSITIVE_VARIABLES.has(name) ? '--sensitive' : '--no-sensitive',
        '--yes',
        '--scope',
        team,
      ],
      { show: false, input: value, env: linkedTo(team, part.project) },
    );
  }
}

/**
 * Sets the project's Root Directory through the Vercel CLI's own authenticated request, so the
 * token stays in the child's environment. `sourceFilesOutsideRootDirectory` lets `apps/web` build
 * with the workspace packages beside it. Idempotent, and it replaces a value set by hand.
 */
async function setRootDirectory(context: DeployContext, part: Part, team: string): Promise<void> {
  if (part.rootDirectory === undefined) return;
  const body =
    part.rootDirectory === null
      ? { rootDirectory: null }
      : { rootDirectory: part.rootDirectory, sourceFilesOutsideRootDirectory: true };
  await runStep(
    context,
    'vercel',
    [
      'api',
      `/v9/projects/${part.project}?teamId=${encodeURIComponent(team)}`,
      '-X',
      'PATCH',
      '--input',
      '-',
      '--scope',
      team,
    ],
    { show: false, input: JSON.stringify(body), env: linkedTo(team, part.project) },
  );
}
