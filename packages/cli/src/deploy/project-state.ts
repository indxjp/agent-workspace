import { randomBytes } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { FeatureId } from '@indx-workspace/contracts/features';
import type { ProjectPolicy } from '@indx-workspace/contracts/policy-ceiling';
import type { ProductionApp, ProductionEnvironment } from '@indx-workspace/contracts/project-file';
import { parse } from 'yaml';

import { createWorkspace } from '../create.ts';
import { type DeploymentImages } from '../deployment.ts';
import { renderProfileDocument, type DeploymentProfile } from '../profile.ts';
import { writeFileAtomically } from '../render/write-file.ts';
import {
  appSecretNames,
  COMPOSE_APPS_FILE,
  COMPOSE_FILE_WITH_APPS,
  composeApps,
  renderComposeApps,
  renderEmptyComposeApps,
} from './compose-apps.ts';
import { canonicalJson } from './project-policy.ts';
import { isPresent } from './project-prerequisites.ts';
import { type DeployProjectEnvironmentOptions } from './project-types.ts';
import { DEPLOY_RECIPES } from './recipes.ts';

/**
 * `.env` with `BOOTSTRAP_ADMIN` set to the project's Owner. `render` owns only the image lines, so
 * an Owner email changed after the first deploy is carried here; no other line — the master key
 * and the generated password included — is touched.
 */
function withBootstrapAdmin(env: string, email: string): string {
  return env.replace(/^BOOTSTRAP_ADMIN=.*$/mu, () => `BOOTSTRAP_ADMIN=${email}`);
}

const POLICY_LINE = /^AW_DEPLOYMENT_POLICY=/u;

/**
 * `.env` with `AW_DEPLOYMENT_POLICY` set to the project's policy ceiling, or without the line when
 * the project has none: the project file owns the deployment's ceiling, as it owns its Owner. The
 * JSON is single-quoted, which Compose reads literally (no `$` interpolation, no `#` comment), and
 * its own `'` is written as the JSON escape `\u0027`, the same string.
 */
function withDeploymentPolicy(env: string, policy: ProjectPolicy | undefined): string {
  const rest = env
    .split('\n')
    .filter((line) => !POLICY_LINE.test(line))
    .join('\n');
  if (policy === undefined) return rest;
  const json = canonicalJson(policy).replaceAll("'", '\\u0027');
  return `${rest.trimEnd()}\nAW_DEPLOYMENT_POLICY='${json}'\n`;
}

const FEATURES_LINE = /^AW_DEPLOYMENT_FEATURES=/u;

/**
 * `.env` with `AW_DEPLOYMENT_FEATURES` set to the project's features as a comma-separated list, or
 * without the line when the project has none (ADR-0160 D5): the project file owns which features
 * the deployment installs, as it owns its ceiling. Feature ids are `[a-z]`, so no quoting is needed.
 */
function withDeploymentFeatures(env: string, features: readonly FeatureId[] | undefined): string {
  const rest = env
    .split('\n')
    .filter((line) => !FEATURES_LINE.test(line))
    .join('\n');
  if (features === undefined) return rest;
  return `${rest.trimEnd()}\nAW_DEPLOYMENT_FEATURES=${features.join(',')}\n`;
}

const PUBLIC_URL_LINE = /^AW_PUBLIC_URL=/u;
const PUBLIC_URL_COMMENT =
  '# Public https origin of this deployment (no path). A2A agent cards (ADR-0135) and the OAuth issuer (ADR-0134) use it; empty keeps them off.';

/**
 * `.env` with `AW_PUBLIC_URL` set to the project's production origin: the project file owns the
 * deployment's public URL, and an upsert (unlike `render`, which never runs again for an existing
 * state directory) reaches deployments made before this line existed. Appended last, with its
 * comment, so a repeat run rewrites the same bytes.
 */
function withPublicUrl(env: string, url: string): string {
  const rest = env
    .split('\n')
    .filter((line) => line !== PUBLIC_URL_COMMENT && !PUBLIC_URL_LINE.test(line))
    .join('\n');
  return `${rest.trimEnd()}\n${PUBLIC_URL_COMMENT}\nAW_PUBLIC_URL=${new URL(url).origin}\n`;
}

const COMPOSE_FILE_LINE = /^COMPOSE_FILE=/u;

/** The name of a `NAME=value` line of `.env`, or `undefined` for a comment or a blank line. */
function lineName(line: string): string | undefined {
  return /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line)?.[1];
}

/**
 * `.env` with each app's database password and identity secret (issue #1512), generated once (32
 * random bytes, base64url, so a URL carries them unescaped) and kept on every later run, then
 * `COMPOSE_FILE` naming the platform's file and the app overlay. The lines are moved to the end in
 * a fixed order, as `withPublicUrl`'s are, so a repeat run rewrites the same bytes.
 */
function withAppSecrets(env: string, apps: Readonly<Record<string, ProductionApp>>): string {
  const names = composeApps(apps).flatMap(({ envName }) => appSecretNames(envName));
  const owned = new Set([...names, 'COMPOSE_FILE']);
  const lines = env.split('\n');
  const values = new Map<string, string>();
  for (const line of lines) {
    const name = lineName(line);
    if (name !== undefined && owned.has(name)) values.set(name, line.slice(name.length + 1));
  }
  const rest = lines.filter((line) => !owned.has(lineName(line) ?? '')).join('\n');
  const secrets = names.map(
    (name) => `${name}=${values.get(name) ?? randomBytes(32).toString('base64url')}`,
  );
  return [rest.trimEnd(), ...secrets, `COMPOSE_FILE=${COMPOSE_FILE_WITH_APPS}`, ''].join('\n');
}

/** `.env` without `COMPOSE_FILE`: Compose reads `compose.yaml` alone again. Secrets are kept. */
function withoutComposeFile(env: string): string {
  return env
    .split('\n')
    .filter((line) => !COMPOSE_FILE_LINE.test(line))
    .join('\n');
}

/** The `app-<name>` services an overlay a previous run wrote starts, for the left-running line. */
async function overlayAppServices(file: string): Promise<readonly string[]> {
  const overlay: unknown = parse(await readFile(file, 'utf8'));
  const services =
    typeof overlay === 'object' &&
    overlay !== null &&
    !Array.isArray(overlay) &&
    'services' in overlay &&
    typeof overlay.services === 'object' &&
    overlay.services !== null &&
    !Array.isArray(overlay.services)
      ? overlay.services
      : {};
  return Object.keys(services).filter((service) => !service.endsWith('-role'));
}

/**
 * single-vm's app overlay (issue #1512): with apps, `<state>/compose.apps.yaml` is written (`0600`,
 * like `.env`) and `.env` gains the apps' secrets and `COMPOSE_FILE`. With none, an overlay a
 * previous run wrote is emptied and `COMPOSE_FILE` dropped; its containers are left running,
 * because `aw deploy` never destroys (ADR-0103), and the secrets are kept for a later re-add.
 * Returns the next `.env`.
 */
async function syncComposeApps(
  stateDirectory: string,
  deployed: ProductionEnvironment,
  env: string,
): Promise<string> {
  const apps = deployed.apps ?? {};
  const overlayFile = path.join(stateDirectory, COMPOSE_APPS_FILE);
  if (Object.keys(apps).length > 0) {
    await writeFileAtomically(overlayFile, renderComposeApps(apps, deployed.url), 0o600);
    return withAppSecrets(env, apps);
  }
  if (!(await isPresent(overlayFile))) return env;
  const running = await overlayAppServices(overlayFile);
  await writeFileAtomically(overlayFile, renderEmptyComposeApps(), 0o600);
  if (running.length > 0) {
    process.stderr.write(
      `app containers ${running.join(', ')} are left running; aw deploy never removes them\n`,
    );
  }
  return withoutComposeFile(env);
}

/** Beside a project's environment states: the directory of the project that owns them. */
function stateOwnerFile(stateDirectory: string): string {
  return path.join(path.dirname(stateDirectory), 'project-directory');
}

/**
 * The state is keyed by the project's name, so two projects of one name would share it, and the
 * second would be told its deployment is up to date (BH061-028). The first project to deploy
 * records its directory; any other directory is refused rather than handed that state.
 */
export async function claimState(stateDirectory: string, projectDirectory: string): Promise<void> {
  const owner = stateOwnerFile(stateDirectory);
  const mine = path.resolve(projectDirectory);
  if (!(await isPresent(owner))) {
    await mkdir(path.dirname(owner), { recursive: true, mode: 0o700 });
    await writeFileAtomically(owner, `${mine}\n`, null);
    return;
  }
  const recorded = (await readFile(owner, 'utf8')).trim();
  if (recorded !== mine) {
    throw new Error(
      `The deployment state in ${path.dirname(stateDirectory)} belongs to the project at ` +
        `${recorded}, which has the same name. Give this project another name in its ` +
        `agent-workspace.yaml, or, if that project has moved here, delete ${owner}. ` +
        'Nothing was created.',
    );
  }
}

/**
 * The state directory and its `.env` kept in step with the project: created on the first run with
 * generated secrets and `images`, and otherwise only the profile and the lines the project file
 * owns are rewritten. The TLS proxy settings are applied until their marker is present, so a first
 * run interrupted after `createWorkspace` is still hardened, and an Owner's later edit is kept.
 * `.env` is replaced through a file opened `0600`, so the secrets are never readable by anyone else.
 */
export async function syncDeploymentState(
  options: DeployProjectEnvironmentOptions,
  deployed: ProductionEnvironment,
  profile: DeploymentProfile,
  state: { readonly created: boolean; readonly images: () => DeploymentImages },
): Promise<string> {
  const { project, stateDirectory } = options;
  const { created, images } = state;
  const recipe = DEPLOY_RECIPES[deployed.target];
  const envFile = path.join(stateDirectory, '.env');
  if (created) {
    // Resolved first, so an unpublished release is refused before anything is created.
    const initial = images();
    await mkdir(path.dirname(stateDirectory), { recursive: true, mode: 0o700 });
    await createWorkspace(stateDirectory, null, {
      deployState: { profile, projectName: project.name },
      images: initial,
    });
  } else {
    await writeFileAtomically(
      path.join(stateDirectory, 'agent-workspace.yaml'),
      renderProfileDocument(profile),
      null,
    );
  }
  const current = await readFile(envFile, 'utf8');
  let next = recipe.hardenEnv(withBootstrapAdmin(current, profile.identity.bootstrapAdmin));
  // Compose forwards these lines to single-vm's web; `render` gives them to Cloud Run's web as the
  // gcp-cloudrun module's `deployment_policy` and `deployment_features`.
  next = withDeploymentPolicy(next, project.policy);
  next = withDeploymentFeatures(next, project.features);
  if (deployed.target === 'single-vm') {
    next = await syncComposeApps(stateDirectory, deployed, next);
  }
  next = withPublicUrl(next, deployed.url);
  if (next !== current) await writeFileAtomically(envFile, next, 0o600);
  return envFile;
}
