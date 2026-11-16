import { statSync } from 'node:fs';
import path from 'node:path';
import { VERCEL_PARTS } from '../render/vercel.ts';
import { type DeployContext } from './steps.ts';
import type { DeployTarget } from './targets.ts';
import {
  awsCredentials,
  gatewayVariables,
  MANAGER_VARIABLES,
  managerEnvironment,
  NOT_PROJECT_VARIABLES,
  selected,
  toolHostVariables,
} from './vercel-environment.ts';
import { requiredEnvironment } from './vercel-settings.ts';

export type VercelTarget = Extract<DeployTarget, { kind: 'vercel' }>;

/** The project's own `web/` directory, set by `aw deploy`; absent when the project has no frontend. */
const FRONTEND_VARIABLE = 'AGENT_WORKSPACE_FRONTEND';

/** The control plane's public URL, set by `aw deploy` from the project file's `url`. */
const CONTROL_PLANE_URL_VARIABLE = 'CONTROL_PLANE_URL';

/** The variable a Vite frontend reads the control plane's address from. */
export const FRONTEND_BASE_URL_VARIABLE = 'VITE_AW_BASE_URL';

/** The package the control plane project builds; the other parts' packages are in `VERCEL_PARTS`. */
const CONTROL_PLANE_PACKAGE = 'apps/web';

/** The package a rendered part builds: the one its `--filter` names. */
function platformPackage(part: 'gateway' | 'manager'): string {
  const filter = VERCEL_PARTS.find((candidate) => candidate.part === part)?.filter;
  if (filter === undefined || filter === null) throw new Error(`No Vercel part named ${part}.`);
  return filter.replace(/^\.\//u, '');
}

/**
 * Where a Vercel control plane keeps the runtime verifications setup records. A function can write
 * only below `/tmp`, so the production default (`/var/lib/...`) cannot be created there and setup's
 * runtime test fails after the manager has already answered. `/tmp` lasts as long as the function
 * instance, the same lifetime as the in-memory fallback a read-only filesystem gets.
 */
const VERIFICATION_FILE_VARIABLE = 'AW_RUNTIME_VERIFICATION_FILE';

const VERCEL_VERIFICATION_FILE = '/tmp/agent-workspace/runtime-verifications.json';

/** One Vercel project of the deployment, with the variables it alone holds. */
export interface Part {
  readonly label: 'control plane' | 'gateway' | 'manager' | 'frontend';
  readonly project: string;
  readonly settingsFile: string;
  /**
   * What `vercel deploy` uploads, pruned: a platform package with the workspace packages it
   * depends on, or the project's own directory.
   */
  readonly upload: { readonly platformPackage: string } | { readonly directory: string };
  /**
   * The project's Root Directory, set on every apply: a path, or `null` for the upload root. Absent
   * for the frontend, which uploads its own directory and keeps whatever the project has.
   */
  readonly rootDirectory?: string | null;
  /** Whether the project is one function, the package's compiled `dist/api/index.js` re-exported at the upload root. */
  readonly functionEntry?: boolean;
  readonly variables: readonly (readonly [string, string])[];
}

/** The production address a project answers at before a custom domain: Vercel's project domain. */
export function vercelProductionUrl(project: string): string {
  return `https://${project}.vercel.app`;
}

/** An address from `.env` (a custom domain), or the project's own production URL. */
export function addressOf(
  dotEnv: Readonly<Record<string, string>>,
  name: string,
  project: string,
  fallback: string = vercelProductionUrl(project),
): string {
  const given = dotEnv[name]?.trim() ?? '';
  if (given === '') return fallback;
  let origin: string | null;
  try {
    const url = new URL(given);
    origin = url.protocol === 'https:' && url.pathname === '/' ? url.origin : null;
  } catch {
    origin = null;
  }
  if (origin === null) {
    throw new Error(`${name} is ${given} in .env: it must be an https origin. Nothing was run.`);
  }
  return origin;
}

/** The frontend directory `aw deploy` named, or `null`; a name that is not a Vite project is refused. */
export function frontendDirectory(context: DeployContext): string | null {
  const given = context.env[FRONTEND_VARIABLE]?.trim() ?? '';
  if (given === '') return null;
  const directory = path.resolve(context.directory, given);
  if (
    statSync(path.join(directory, 'package.json'), { throwIfNoEntry: false })?.isFile() !== true
  ) {
    throw new Error(
      `${FRONTEND_VARIABLE} is ${directory}, which has no package.json: point it at the project's ` +
        'web/ directory. Nothing was run.',
    );
  }
  return directory;
}

export function partsOf(
  context: DeployContext,
  target: VercelTarget,
  team: string,
  dotEnv: Readonly<Record<string, string>>,
): { readonly parts: readonly Part[]; readonly addresses: ReadonlyMap<string, string> } {
  const gatewayProject = `${target.projectName}-gateway`;
  const managerProject = `${target.projectName}-manager`;
  const gatewayUrl = addressOf(dotEnv, 'MODEL_GATEWAY_URL', gatewayProject);
  const managerUrl = addressOf(dotEnv, 'RUNNER_MANAGER_URL', managerProject);

  const addresses = new Map([
    ['MODEL_GATEWAY_URL', gatewayUrl],
    ['RUNNER_MANAGER_URL', managerUrl],
  ]);
  const input = {
    target,
    team,
    dotEnv,
    gatewayProject,
    managerProject,
    gatewayUrl,
    addresses,
    settingsDirectory: path.dirname(target.settingsFile),
  };
  const controlPlaneVariables = controlPlaneEnvironment(input);
  const parts: Part[] = [
    gatewayPart(input),
    managerPart(input),
    controlPlanePart(input, controlPlaneVariables),
  ];

  appendFrontend(context, input, parts);
  return { parts, addresses };
}

interface PartSettings {
  readonly target: VercelTarget;
  readonly team: string;
  readonly dotEnv: Readonly<Record<string, string>>;
  readonly gatewayProject: string;
  readonly managerProject: string;
  readonly gatewayUrl: string;
  readonly addresses: ReadonlyMap<string, string>;
  readonly settingsDirectory: string;
}

function controlPlaneEnvironment({ dotEnv, addresses }: PartSettings) {
  return Object.entries({ ...dotEnv, ...awsCredentials(dotEnv) })
    .filter(([name, value]) => value !== '' && !NOT_PROJECT_VARIABLES.has(name))
    .filter(([name]) => !addresses.has(name))
    .map(([name, value]): [string, string] => [name, value.trim()]);
}

function gatewayPart({ target, dotEnv, gatewayProject, settingsDirectory }: PartSettings): Part {
  return {
    label: 'gateway',
    project: gatewayProject,
    settingsFile: path.join(settingsDirectory, 'gateway.json'),
    upload: { platformPackage: platformPackage('gateway') },
    rootDirectory: null,
    functionEntry: true,
    // The control plane's own production URL, derived like the gateway's: aw-control calls go there.
    variables: [
      ...gatewayVariables(dotEnv),
      ['GATEWAY_CONTROL_PLANE_ORIGIN', vercelProductionUrl(target.projectName)],
    ],
  };
}

function managerPart({
  dotEnv,
  team,
  managerProject,
  gatewayUrl,
  settingsDirectory,
}: PartSettings): Part {
  return {
    label: 'manager',
    project: managerProject,
    settingsFile: path.join(settingsDirectory, 'manager.json'),
    upload: { platformPackage: platformPackage('manager') },
    rootDirectory: null,
    functionEntry: true,
    variables: [
      ...selected(managerEnvironment(dotEnv), MANAGER_VARIABLES),
      ...toolHostVariables(dotEnv),
      ['RUNNER_MANAGER_STATELESS', 'true'],
      ['GATEWAY_PUBLIC_URL', gatewayUrl],
      ...(dotEnv['RUNTIME_DRIVER']?.trim() === 'vercel-sandbox'
        ? [['AW_VERCEL_TEAM_ID', team] as const]
        : []),
    ],
  };
}

function controlPlanePart(
  { target, dotEnv, addresses }: PartSettings,
  variables: Part['variables'],
): Part {
  return {
    label: 'control plane',
    project: target.projectName,
    settingsFile: target.settingsFile,
    upload: { platformPackage: CONTROL_PLANE_PACKAGE },
    rootDirectory: CONTROL_PLANE_PACKAGE,
    variables: [
      ...variables,
      ...(dotEnv[VERIFICATION_FILE_VARIABLE]?.trim()
        ? []
        : [[VERIFICATION_FILE_VARIABLE, VERCEL_VERIFICATION_FILE] as const]),
      ...toolHostVariables(dotEnv),
      ...addresses,
    ],
  };
}

function appendFrontend(
  context: DeployContext,
  { target, settingsDirectory }: PartSettings,
  parts: Part[],
): void {
  const frontend = frontendDirectory(context);
  if (frontend !== null) {
    parts.push({
      label: 'frontend',
      project: `${target.projectName}-web`,
      settingsFile: path.join(settingsDirectory, 'frontend.json'),
      upload: { directory: frontend },
      variables: [
        [
          FRONTEND_BASE_URL_VARIABLE,
          requiredEnvironment(
            context.env,
            CONTROL_PLANE_URL_VARIABLE,
            "the control plane's public address (aw deploy sets it from the project file's url)",
          ).replace(/\/+$/u, ''),
        ],
      ],
    });
  }
}
