/**
 * The Vercel project settings a `cloud: vercel` profile renders: `deploy/vercel/vercel.json`.
 *
 * It is Vercel's own project file, so nothing else needs to learn a format. It carries the
 * framework preset, the scoped install and build, and the Cron job that runs session retention
 * instead of the in-process interval (ADR-0120 clause 7). Vendor facts, checked 2026-10-08:
 * Vercel Cron sends an HTTP GET to the production deployment at `path`, in UTC
 * (https://vercel.com/docs/cron-jobs); `framework`, `installCommand`, `buildCommand` and `crons`
 * are `vercel.json` properties (https://vercel.com/docs/project-configuration).
 */
import type { DeploymentProfile } from '../profile.ts';

/** The route `apps/web/app/api/cron/retention` serves, authenticated by `CRON_SECRET`. */
export const VERCEL_RETENTION_CRON_PATH = '/api/cron/retention';

/** The route `apps/web/app/api/cron/triggers` serves: the schedule pass (ADR-0144 D5). */
export const VERCEL_TRIGGERS_CRON_PATH = '/api/cron/triggers';

/** The route `apps/web/app/api/cron/storage-cleanup` serves: the storage cleanup (#1674). */
export const VERCEL_STORAGE_CLEANUP_CRON_PATH = '/api/cron/storage-cleanup';

/**
 * pnpm's filter for the control plane: the install and build commands run in its Root Directory,
 * `apps/web`, so `{.}` is that package (a `./apps/web` filter would match nothing there). The
 * package name is not used because the published CLI bundle must not name a private package.
 */
const CONTROL_PLANE_FILTER = '{.}';

/** Daily, so the schedule is valid on every plan including Hobby (ADR-0120 clause 7). */
const RETENTION_SCHEDULE = '0 3 * * *';

// ponytail: daily so Hobby accepts it, which fires a missed window once a day; every minute needs Pro.
const TRIGGERS_SCHEDULE = '0 4 * * *';

// ponytail: daily so Hobby accepts it (it rejects sub-daily crons at deploy time); the storage design
// §04 runs the cleanup hourly, which a Pro project gets by changing this to '0 * * * *'.
const STORAGE_CLEANUP_SCHEDULE = '0 5 * * *';

export interface VercelProjectArtefact {
  /** The directory under `deploy/` the settings are written in. */
  readonly directory: string;
  readonly fileName: string;
  readonly contents: string;
}

/** Render the project settings, or `null` when the profile's cloud is not `vercel`. */
export function renderVercelProject(profile: DeploymentProfile): VercelProjectArtefact | null {
  if (profile.cloud !== 'vercel') return null;
  const settings = {
    framework: 'nextjs',
    // The workspace packages `apps/web` imports export their `dist`, so they are built before
    // `next build`, and only they are installed (`...` is the package and its dependencies).
    installCommand: `pnpm install --frozen-lockfile --filter "${CONTROL_PLANE_FILTER}..."`,
    buildCommand: `pnpm --filter "${CONTROL_PLANE_FILTER}^..." run build && pnpm run build`,
    crons: [
      { path: VERCEL_RETENTION_CRON_PATH, schedule: RETENTION_SCHEDULE },
      { path: VERCEL_TRIGGERS_CRON_PATH, schedule: TRIGGERS_SCHEDULE },
      { path: VERCEL_STORAGE_CLEANUP_CRON_PATH, schedule: STORAGE_CLEANUP_SCHEDULE },
    ],
  };
  return {
    directory: 'vercel',
    fileName: 'vercel.json',
    contents: JSON.stringify(settings, null, 2) + '\n',
  };
}

/**
 * The parts beside the control plane, each its own Vercel project (ADR-0126): the model gateway,
 * the runner manager and the project's own frontend. `suffix` is appended to the project name.
 * The gateway and the manager are single-function projects whose entry (`src/api/index.ts` in
 * their package) is compiled by the package's own `tsc` build, so the install and build commands
 * are filtered to the package and what it needs.
 * Vercel matches `functions` against the project's root, which is the upload root, so `deploy`
 * writes a JavaScript re-export of the compiled entry at {@link VERCEL_FUNCTION_ENTRY} when it
 * stages: Vercel only bundles it and compiles no TypeScript.
 */
export const VERCEL_PARTS = [
  {
    part: 'gateway',
    suffix: '-gateway',
    fileName: 'gateway.json',
    filter: './packages/gateway',
  },
  {
    part: 'manager',
    suffix: '-manager',
    fileName: 'manager.json',
    filter: './apps/runner',
  },
  { part: 'frontend', suffix: '-web', fileName: 'frontend.json', filter: null },
] as const;

/** Where the function of a gateway or manager project sits, relative to its upload root. */
export const VERCEL_FUNCTION_ENTRY = 'api/index.js';

/** A function runs at most five minutes: the longest a Hobby-tier deployment allows (ADR-0126). */
const FUNCTION_MAX_DURATION_SECONDS = 300;

/**
 * The output directory of a functions-only part. With `framework: null` and a `buildCommand`,
 * Vercel fails the deployment unless the build leaves a non-empty Output Directory behind (default
 * `public`: "No Output Directory named "public" found after the Build completed", then "The Output
 * Directory "public" is empty", journey runs 37933430015 and 37943408960). The part serves nothing
 * static, so the build writes a `robots.txt` that disallows all crawling. Static files win over
 * rewrites, so only `/robots.txt` is shadowed; the gateway and the manager serve no such path.
 * https://vercel.com/docs/project-configuration#outputdirectory, checked 2026-10-10.
 */
export const VERCEL_FUNCTION_OUTPUT_DIRECTORY = 'public';

/** The file that keeps {@link VERCEL_FUNCTION_OUTPUT_DIRECTORY} non-empty. */
export const VERCEL_FUNCTION_STATIC_FILE = 'robots.txt';

const OUTPUT_COMMAND = `mkdir -p ${VERCEL_FUNCTION_OUTPUT_DIRECTORY} && printf 'User-agent: *\\nDisallow: /\\n' > ${VERCEL_FUNCTION_OUTPUT_DIRECTORY}/${VERCEL_FUNCTION_STATIC_FILE}`;

/** Render each part's project settings, or `[]` when the profile's cloud is not `vercel`. */
export function renderVercelPartSettings(
  profile: DeploymentProfile,
): readonly VercelProjectArtefact[] {
  if (profile.cloud !== 'vercel') return [];
  return VERCEL_PARTS.map(({ fileName, filter }) => {
    // `{<dir>}...` is pnpm's form for a directory and its dependencies; `<dir>...` selects only <dir>.
    const settings =
      filter === null
        ? { framework: 'vite' }
        : {
            framework: null,
            installCommand: `pnpm install --frozen-lockfile --filter "{${filter}}..."`,
            buildCommand: `pnpm --filter "{${filter}}..." run build && ${OUTPUT_COMMAND}`,
            outputDirectory: VERCEL_FUNCTION_OUTPUT_DIRECTORY,
            rewrites: [{ source: '/(.*)', destination: '/api' }],
            functions: { [VERCEL_FUNCTION_ENTRY]: { maxDuration: FUNCTION_MAX_DURATION_SECONDS } },
          };
    return { directory: 'vercel', fileName, contents: JSON.stringify(settings, null, 2) + '\n' };
  });
}
