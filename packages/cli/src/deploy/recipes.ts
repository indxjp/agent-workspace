/**
 * What each v2 deploy target means, as one table entry apiece (issue #948): the v1 profile it
 * starts from, the refusals of the project file and of `--infra` it adds, the `.env` hardening it
 * applies, and the steps the Owner reads after a deploy. The prerequisite checks and the executors
 * stay in `project.ts`, which dispatches on the target for them.
 */
import type { VertexLocation } from '@indx-workspace/contracts/models';
import type {
  ProductionApp,
  ProjectDeployTarget,
  ProjectDocument,
} from '@indx-workspace/contracts/project-file';

import { defaultProfile } from '../profile-defaults.ts';
import { ProfileError, type DeploymentProfile } from '../profile.ts';
import { composeProjectName } from '../render/env.ts';
import { appSecretNames, composeApps } from './compose-apps.ts';

/** What `aw deploy` prints after a successful run is built from these. */
interface RecipeFacts {
  readonly projectName: string;
  /** `environments.production.url`. */
  readonly url: string;
  readonly adminEmail: string;
  readonly envFile: string;
  /** The gcp-cloudrun Terraform module the run drove; `null` for the other targets. */
  readonly moduleDirectory: string | null;
  /** Whether `aw deploy` manages the stack (a `gcp` block, no `--infra`), so it can show the password. */
  readonly managedStack: boolean;
  /** `terraform output -raw web_url` once the stack is up; `null` before, and for the other targets. */
  readonly webUrl: string | null;
  /** `gcp.oidc.issuer`: the single sign-on provider; `null` when the Owner password is the only sign-in. */
  readonly oidcIssuer: string | null;
  /** `gcp.domain`; `null` when the web app is reached at its Cloud Run address. */
  readonly domain: string | null;
  /** `terraform output -raw load_balancer_ip` once the stack has a load balancer; else `null`. */
  readonly loadBalancerIp: string | null;
  /** The Vertex AI location of the model connection this run seeded; `null` or unset when none. */
  readonly seededLocation?: VertexLocation | null;
  /** Whether the project has a `web/` frontend the vercel target deployed as its own project. */
  readonly frontend: boolean;
  /** `environments.production.apps`, `{}` when it lists none. */
  readonly apps: Readonly<Record<string, ProductionApp>>;
  /** gcp-cloudrun: app name → its run.app URL from the `apps` output; empty before the stack is up. */
  readonly appUrls?: Readonly<Record<string, string>>;
}

export interface DeployRecipe {
  /** The v1 profile the recipe starts from, before the project's own identity is applied. */
  readonly profile: (projectName: string) => DeploymentProfile;
  /** Refusals of the project file this recipe adds, as a `ProfileError` at the path the user edits. */
  readonly checkProject: (project: ProjectDocument) => void;
  /** The refusal of `--infra` for a target that takes none; `null` when it accepts or needs one. */
  readonly infraRefusal: string | null;
  /** The idempotent `.env` hardening applied on every run. */
  readonly hardenEnv: (env: string) => string;
  /** The lines `aw deploy` prints after "deployed production from <state>". */
  readonly nextSteps: (facts: RecipeFacts) => readonly string[];
}

const TLS_PROXY_MARKER = '# aw deploy: web is reached only through the TLS proxy on this VM.';

/**
 * Web is published on loopback only, and the one proxy in front of it — Caddy, terminating TLS
 * for the environment's `url` (docs/deploy/single-vm.md) — is trusted for `X-Forwarded-For`.
 */
function behindTlsProxy(env: string): string {
  const kept = env
    .split('\n')
    .filter((line) => !/^(?:PORT|AW_TRUSTED_PROXY_HOPS)=/u.test(line))
    .join('\n')
    .trimEnd();
  return [kept, TLS_PROXY_MARKER, 'PORT=127.0.0.1:3000', 'AW_TRUSTED_PROXY_HOPS=1', ''].join('\n');
}

function unchanged(env: string): string {
  return env;
}

/**
 * Issue #1512: only the single-vm, kubernetes and gcp-cloudrun recipes run an app beside the
 * platform; a target with no app service refuses `environments.production.apps` by its path rather than skipping it.
 */
function refuseApps(project: ProjectDocument, target: ProjectDeployTarget): void {
  const apps = project.environments.production?.apps;
  if (apps !== undefined && Object.keys(apps).length > 0) {
    throw new ProfileError(
      'environments.production.apps',
      `is deployed by the single-vm, kubernetes and gcp-cloudrun targets only; the ${target} recipe has no app service yet`,
    );
  }
}

/** PostgreSQL truncates an identifier past 63 bytes, and an app's role is `app_<name>`. */
const APP_NAME_MAX_LENGTH = 59;

/** single-vm creates a role `app_<name>` per app, so a name must leave it a whole identifier. */
function refuseLongAppNames(project: ProjectDocument): void {
  for (const name of Object.keys(project.environments.production?.apps ?? {})) {
    if (name.length > APP_NAME_MAX_LENGTH) {
      throw new ProfileError(
        `environments.production.apps.${name}`,
        `must be named with at most ${String(APP_NAME_MAX_LENGTH)} characters (its database role is app_<name>)`,
      );
    }
  }
}

/** The chart names an app's Deployment and Service `agent-workspace-app-<name>`, a 63-character label. */
const KUBERNETES_APP_NAME_MAX_LENGTH = 43;

/** kubernetes renders a Service per app, so a name must leave it a whole DNS label. */
function refuseLongKubernetesAppNames(project: ProjectDocument): void {
  for (const name of Object.keys(project.environments.production?.apps ?? {})) {
    if (name.length > KUBERNETES_APP_NAME_MAX_LENGTH) {
      throw new ProfileError(
        `environments.production.apps.${name}`,
        `must be named with at most ${String(KUBERNETES_APP_NAME_MAX_LENGTH)} characters for the kubernetes target (its Service is agent-workspace-app-<name>)`,
      );
    }
  }
}

/**
 * The module names an app's Cloud Run service and its Compute resources `<module name>-app-<name>`,
 * and a Cloud Run service name is at most 49 characters (apps.tf checks it). The module name is at
 * most 19 (`moduleResourceName`).
 */
const GCP_APP_NAME_MAX_LENGTH = 49 - 19 - '-app-'.length;

/** gcp-cloudrun runs a Cloud Run service per app, so a name must leave it a whole resource name. */
function refuseLongGcpAppNames(project: ProjectDocument): void {
  for (const name of Object.keys(project.environments.production?.apps ?? {})) {
    if (name.length > GCP_APP_NAME_MAX_LENGTH) {
      throw new ProfileError(
        `environments.production.apps.${name}`,
        `must be named with at most ${String(GCP_APP_NAME_MAX_LENGTH)} characters for the gcp-cloudrun target (its service is <name>-app-<name>)`,
      );
    }
  }
}

/**
 * The redirect URI to register with the single sign-on provider: web's callback on the one web
 * origin, the custom domain or the `web_url` output, which is the origin web builds it from. None
 * without single sign-on or before the stack reports its origin.
 */
function oidcRedirectStep(oidcIssuer: string | null, webOrigin: string | null): readonly string[] {
  if (oidcIssuer === null || webOrigin === null) return [];
  return [`next: register ${webOrigin}/api/auth/callback as the redirect URI at ${oidcIssuer}`];
}

/** Per app, what the stack served: its run.app URL, and how its pages are reached. */
function gcpAppSteps(
  apps: Readonly<Record<string, ProductionApp>>,
  appUrls: Readonly<Record<string, string>>,
  domain: string | null,
  loadBalancerIp: string | null,
): readonly string[] {
  if (Object.keys(apps).length === 0) return [];
  return [
    ...composeApps(apps).flatMap(({ name, app }) => [
      `app ${name}: ${appUrls[name] ?? 'not up yet'}`,
      ...(domain === null
        ? [`app ${name}: internal only; set gcp.domain to serve its pages at ${app.url}`]
        : loadBalancerIp === null
          ? []
          : [`next: point ${new URL(app.url).host} at ${loadBalancerIp}`]),
    ]),
    'gap: AW_WORKSPACE_ID, AW_APP_API_KEY and AW_APP_CONNECTOR_ID are not set on Cloud Run yet, so an app answers app_misconfigured past /api/health',
  ];
}

/**
 * Per app, after the platform's own lines (issue #1512): the Caddy site for its host, the `.env`
 * lines the operator fills, and the connector the platform reaches it through. The connector uses
 * the app's public https origin: the gateway's egress policy refuses a plain-http private host.
 */
function singleVmAppSteps(
  apps: Readonly<Record<string, ProductionApp>>,
  envFile: string,
): readonly string[] {
  return composeApps(apps).flatMap(({ name, app, envName, port }) => {
    const [, identitySecret] = appSecretNames(envName);
    // A connector's identity names a workspace secret; `AW_` names are reserved for the runtime.
    const workspaceSecret = `APP_${envName}_IDENTITY`;
    return [
      `next: caddy reverse-proxy --from ${new URL(app.url).host} --to 127.0.0.1:${String(port)}`,
      `next: set AW_APP_${envName}_API_KEY (an Admin API key), AW_APP_${envName}_WORKSPACE_ID and, after registering the connector, AW_APP_${envName}_CONNECTOR_ID in ${envFile}, then aw deploy production --yes`,
      `next: store ${identitySecret}'s value as the workspace secret ${workspaceSecret} (aw secrets create --name ${workspaceSecret} --value-stdin), then register connector ${name} → ${new URL(app.url).origin}/api/mcp with identity: { secret: ${workspaceSecret} } (aw connectors create --file …; docs/deploy/single-vm.md#apps)`,
    ];
  });
}

export const DEPLOY_RECIPES: Readonly<Record<ProjectDeployTarget, DeployRecipe>> = {
  'single-vm': {
    profile: (projectName) =>
      defaultProfile({ cloud: 'local', projectName, localObjectStore: 'seaweedfs' }),
    checkProject: refuseLongAppNames,
    infraRefusal:
      '--infra is for the gcp-cloudrun target; single-vm deploys the Compose project. ' +
      'Nothing was created.',
    // Applied until the marker is present, so a first run interrupted after the workspace was
    // created is still hardened, and an Owner's later edit is kept.
    hardenEnv: (env) => (env.includes(TLS_PROXY_MARKER) ? env : behindTlsProxy(env)),
    nextSteps: ({ url, adminEmail, envFile, apps }) => [
      `next: caddy reverse-proxy --from ${new URL(url).host} --to 127.0.0.1:3000`,
      `next: aw login --url ${url}`,
      `the Owner is ${adminEmail}; the password is BOOTSTRAP_ADMIN_PASSWORD in ${envFile}`,
      ...singleVmAppSteps(apps, envFile),
    ],
  },
  'gcp-cloudrun': {
    profile: (projectName) => defaultProfile({ cloud: 'gcp', projectName }),
    // The recipe's bucket is `<name>-files` and S3 caps it at 63; refuse at the path the user edits.
    checkProject: (project) => {
      refuseLongAppNames(project);
      refuseLongGcpAppNames(project);
      if (project.name.length > 57) {
        throw new ProfileError(
          'name',
          'must be at most 57 characters for the gcp-cloudrun target (its bucket is <name>-files)',
        );
      }
    },
    infraRefusal: null,
    hardenEnv: unchanged,
    // Cloud Run's module generates the Owner's password itself; it is never printed here.
    nextSteps: ({
      adminEmail,
      webUrl,
      managedStack,
      moduleDirectory,
      oidcIssuer,
      domain,
      loadBalancerIp,
      seededLocation,
      apps,
      appUrls = {},
    }) => [
      domain !== null
        ? `web: https://${domain}`
        : webUrl === null
          ? 'web: not up yet; run aw deploy production to bring it up'
          : `web: ${webUrl}`,
      ...(domain !== null && loadBalancerIp !== null
        ? [`next: point ${domain} at ${loadBalancerIp}`]
        : []),
      oidcIssuer === null
        ? 'sign-in: Owner password (set gcp.oidc for single sign-on)'
        : `sign-in: single sign-on through ${oidcIssuer}; the Owner password stays as a break-glass sign-in`,
      ...oidcRedirectStep(oidcIssuer, domain === null ? webUrl : `https://${domain}`),
      seededLocation === undefined || seededLocation === null
        ? 'model: connect one on the Models screen if you have not yet'
        : `model: Claude on Vertex AI (${seededLocation}), using this install's Google Cloud identity`,
      `owner: ${adminEmail}`,
      managedStack || moduleDirectory === null
        ? 'owner password: aw deploy production --show-owner-password'
        : `owner password: terraform -chdir=${moduleDirectory} output -raw bootstrap_admin_password`,
      ...gcpAppSteps(apps, appUrls, domain, loadBalancerIp),
    ],
  },
  kubernetes: {
    // The chart is installed from its own values, not from a rendered v1 deployment.
    profile: () => {
      throw new ProfileError(
        'environments.production.target',
        'kubernetes has no v1 deployment profile; it installs the Helm chart',
      );
    },
    checkProject: refuseLongKubernetesAppNames,
    infraRefusal: null,
    hardenEnv: unchanged,
    nextSteps: ({ url, apps }) => [
      'the chart reads three Secrets you create in the agent-workspace namespace: agent-workspace-database, agent-workspace-object-store, agent-workspace-secrets',
      `next: point ${new URL(url).host} at the ingress controller: kubectl -n agent-workspace get ingress`,
      `next: aw login --url ${url}`,
      'the Owner and password are BOOTSTRAP_ADMIN and BOOTSTRAP_ADMIN_PASSWORD in agent-workspace-secrets',
      // Each app's role, schema and Secret are the operator's, as the platform's Secrets are.
      ...composeApps(apps).map(
        ({ name }) =>
          `next: create Secret agent-workspace-app-${name} (docs/deploy/kubernetes.md#apps)`,
      ),
    ],
  },
  vercel: {
    profile: (projectName) => defaultProfile({ cloud: 'vercel', projectName }),
    checkProject: (project) => {
      refuseApps(project, 'vercel');
    },
    infraRefusal:
      '--infra is for the gcp-cloudrun and kubernetes targets; vercel deploys the checkout in ' +
      'AGENT_WORKSPACE_SOURCE. Nothing was created.',
    hardenEnv: unchanged,
    nextSteps: ({ projectName, url, adminEmail, envFile, frontend }) => [
      // The browser calls the control plane from the frontend's own domain; CORS lists only allowedOrigins.
      ...(frontend
        ? [
            `next: aw push and aw promote the agent; unless deploy said otherwise above, the control plane allows https://${composeProjectName(projectName)}-web.vercel.app; list a custom domain in allowedOrigins of the surface web/ calls`,
          ]
        : []),
      `next: attach ${new URL(url).host} to the control-plane Vercel project (Settings, Domains) if it is not a *.vercel.app address`,
      `next: aw login --url ${url}`,
      `the Owner is ${adminEmail}; the password is BOOTSTRAP_ADMIN_PASSWORD in ${envFile}`,
    ],
  },
};
