/**
 * The Google Cloud preflight of `agent-workspace deploy`: one report of every check, run before
 * anything is created (BYOC GCP phase P1).
 *
 * Plain functions over the injected `ToolRunner`. Every check runs, even after one fails, so the
 * operator sees every problem at once, and each failure carries exactly one copy-paste fix. The
 * run creates nothing, except that `apply` enables the missing APIs once every other check has
 * passed. The two access tokens are held in memory only: `runStep` echoes the command line, never
 * a tool's stdout, and the token is neither printed nor returned.
 */
import { VERTEX_DEFAULT_MODEL, type VertexLocation } from '@indx-workspace/contracts/models';

import { runStep, type DeployContext } from './steps.ts';

/** The APIs `modules/gcp-cloudrun/main.tf` enables; a test holds this list equal to its `locals`. */
export const REQUIRED_GCP_APIS: readonly string[] = [
  'run.googleapis.com',
  'sqladmin.googleapis.com',
  'sql-component.googleapis.com',
  'secretmanager.googleapis.com',
  'cloudkms.googleapis.com',
  'artifactregistry.googleapis.com',
  'storage.googleapis.com',
  'iam.googleapis.com',
  'cloudresourcemanager.googleapis.com',
  'logging.googleapis.com',
  'monitoring.googleapis.com',
  'compute.googleapis.com',
  'servicenetworking.googleapis.com',
  'dns.googleapis.com',
  'aiplatform.googleapis.com',
];

/** The permissions only the alerting resources need; the module creates those only with `alerts_email`. */
const ALERTING_GCP_PERMISSIONS: readonly string[] = [
  'monitoring.alertPolicies.create',
  'monitoring.notificationChannels.create',
  'monitoring.uptimeCheckConfigs.create',
];

/** The permissions the module needs from the person who deploys, with alerting (`alerts_email`) set. */
export const REQUIRED_GCP_PERMISSIONS: readonly string[] = [
  'resourcemanager.projects.get',
  'serviceusage.services.enable',
  'iam.serviceAccounts.create',
  'resourcemanager.projects.setIamPolicy',
  'iam.serviceAccounts.actAs',
  'run.services.create',
  'cloudsql.instances.create',
  'storage.buckets.create',
  'secretmanager.secrets.create',
  'cloudkms.keyRings.create',
  'artifactregistry.repositories.create',
  'logging.logMetrics.create',
  'monitoring.dashboards.create',
  'monitoring.alertPolicies.create',
  'monitoring.notificationChannels.create',
  'monitoring.uptimeCheckConfigs.create',
];

/** The permissions this deploy needs: the alerting ones only when `gcp.alertsEmail` is set. */
function requiredPermissions(alertsEmail: string | undefined): readonly string[] {
  return alertsEmail === undefined
    ? REQUIRED_GCP_PERMISSIONS.filter(
        (permission) => !ALERTING_GCP_PERMISSIONS.includes(permission),
      )
    : REQUIRED_GCP_PERMISSIONS;
}

/** The narrowest predefined role that holds each required permission. */
const ROLE_OF_PERMISSION: Readonly<Record<string, string>> = {
  'resourcemanager.projects.get': 'roles/resourcemanager.projectIamAdmin',
  'serviceusage.services.enable': 'roles/serviceusage.serviceUsageAdmin',
  'iam.serviceAccounts.create': 'roles/iam.serviceAccountAdmin',
  'resourcemanager.projects.setIamPolicy': 'roles/resourcemanager.projectIamAdmin',
  'iam.serviceAccounts.actAs': 'roles/iam.serviceAccountUser',
  'run.services.create': 'roles/run.admin',
  'cloudsql.instances.create': 'roles/cloudsql.admin',
  'storage.buckets.create': 'roles/storage.admin',
  'secretmanager.secrets.create': 'roles/secretmanager.admin',
  'cloudkms.keyRings.create': 'roles/cloudkms.admin',
  'artifactregistry.repositories.create': 'roles/artifactregistry.admin',
  'logging.logMetrics.create': 'roles/logging.configWriter',
  'monitoring.dashboards.create': 'roles/monitoring.dashboardEditor',
  'monitoring.alertPolicies.create': 'roles/monitoring.alertPolicyEditor',
  'monitoring.notificationChannels.create': 'roles/monitoring.notificationChannelEditor',
  'monitoring.uptimeCheckConfigs.create': 'roles/monitoring.uptimeCheckConfigEditor',
};

const MINIMUM_TERRAFORM = [1, 8, 0] as const;
const GCLOUD_INSTALL_URL = 'https://cloud.google.com/sdk/docs/install';
const SIGN_IN = 'gcloud auth application-default login';
const ACCOUNT_SIGN_IN = 'gcloud auth login';
const TERRAFORM_VERSION = '1.9.8';
const TERRAFORM_DOWNLOADS = 'https://developer.hashicorp.com/terraform/install';
const TERRAFORM_ARCHITECTURES: Readonly<Record<string, string>> = { x64: 'amd64', arm64: 'arm64' };

/**
 * The command that installs Terraform for this machine: the archive for its platform and
 * architecture when HashiCorp ships one this command can unpack, else the download page.
 */
function terraformInstall(platform: string, arch: string): string {
  const architecture = TERRAFORM_ARCHITECTURES[arch];
  if ((platform !== 'linux' && platform !== 'darwin') || architecture === undefined) {
    return TERRAFORM_DOWNLOADS;
  }
  const archive = `terraform_${TERRAFORM_VERSION}_${platform}_${architecture}.zip`;
  const release = `https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}`;
  return (
    'tmp="$(mktemp -d)" && mkdir -p ~/bin && ' +
    `curl -fsSLo "$tmp/${archive}" ${release}/${archive} && ` +
    `curl -fsSLo "$tmp/SHA256SUMS" ${release}/terraform_${TERRAFORM_VERSION}_SHA256SUMS && ` +
    `(cd "$tmp" && grep " ${archive}$" SHA256SUMS | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -)) && ` +
    `unzip -oq "$tmp/${archive}" -d ~/bin && export PATH="$HOME/bin:$PATH"`
  );
}
const DOCKER_BUILDX_INSTALL = 'https://docs.docker.com/build/concepts/overview/#install-buildx';

type GcpPreflightStatus = 'ok' | 'fail' | 'warn' | 'fixed';

interface GcpPreflightCheck {
  readonly id: string;
  readonly title: string;
  readonly status: GcpPreflightStatus;
  /** The one copy-paste command (or URL) that resolves the check. */
  readonly fix?: string;
}

export interface GcpPreflightReport {
  readonly project: string;
  readonly region: string;
  /** The project's number, when the project was found. */
  readonly projectNumber?: string;
  readonly checks: readonly GcpPreflightCheck[];
  /** True when no check failed. */
  readonly passed: boolean;
}

export interface GcpPreflightInput {
  readonly context: DeployContext;
  readonly project: string;
  readonly region: string;
  /** Enable the missing APIs, but only when every other check passed. */
  readonly apply: boolean;
  /** Where Claude on Vertex AI runs (`gcp.modelLocation`); `global` when unset. */
  readonly modelLocation?: VertexLocation;
  readonly fetch?: typeof fetch;
  /** `gcp.domain`: the host name the web app is served at behind the load balancer. */
  readonly domain?: string;
  /** `gcp.alertsEmail`: the alerting permissions are required only when it is set. */
  readonly alertsEmail?: string;
  /** `gcp.iap`: with a `domain`, only signed-in Google identities reach the web app. */
  readonly iap?: boolean;
  /** The load balancer's address from the last deploy, or `null` when there is none yet. */
  readonly loadBalancerIp?: () => Promise<string | null>;
  /** Resolves `domain`; the DNS check is skipped when this is not given. */
  readonly resolveHost?: (hostname: string) => Promise<unknown>;
  /** The machine the tools run on; the Terraform install fix is chosen for it. */
  readonly host?: { readonly platform: string; readonly arch: string };
}

type Probe = { readonly ok: true; readonly stdout: string } | { readonly ok: false };

async function probe(
  context: DeployContext,
  tool: 'gcloud' | 'terraform' | 'docker',
  args: readonly string[],
): Promise<Probe> {
  try {
    const result = await runStep(context, tool, args, { show: false });
    return { ok: true, stdout: result.stdout };
  } catch {
    // The failure (a missing tool or a non-zero exit) is the check's result; `runStep` has
    // already printed what the tool said.
    return { ok: false };
  }
}

function check(
  id: string,
  title: string,
  status: GcpPreflightStatus,
  fix?: string,
): GcpPreflightCheck {
  return fix === undefined ? { id, title, status } : { id, title, status, fix };
}

function atLeast(version: string, minimum: readonly number[]): boolean {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  for (const [index, wanted] of minimum.entries()) {
    const have = parts[index] ?? 0;
    if (Number.isNaN(have)) return false;
    if (have !== wanted) return have > wanted;
  }
  return true;
}

function terraformVersion(stdout: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (typeof parsed === 'object' && parsed !== null && 'terraform_version' in parsed) {
      const version = parsed.terraform_version;
      return typeof version === 'string' ? version : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/** True when an effective org policy (JSON from `gcloud org-policies describe`) restricts anything. */
function isEnforced(stdout: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return false;
  }
  const rules = field(field(parsed, 'spec'), 'rules');
  if (!Array.isArray(rules)) return false;
  return rules.some((rule: unknown) => {
    if (field(rule, 'enforce') === true || field(rule, 'denyAll') === true) return true;
    const values = field(rule, 'values');
    return ['allowedValues', 'deniedValues'].some((key) => {
      const list = field(values, key);
      return Array.isArray(list) && list.length > 0;
    });
  });
}

/** Which of `constraints` are enforced, and whether any could not be read. */
async function orgPolicies(
  context: DeployContext,
  project: string,
  constraints: readonly string[],
): Promise<{ readonly enforced: readonly string[]; readonly unreadable: boolean }> {
  const enforced: string[] = [];
  let unreadable = false;
  for (const constraint of constraints) {
    const result = await probe(context, 'gcloud', [
      'org-policies',
      'describe',
      constraint,
      '--project',
      project,
      '--effective',
      '--format=json',
    ]);
    if (!result.ok) unreadable = true;
    else if (isEnforced(result.stdout)) enforced.push(constraint);
  }
  return { enforced, unreadable };
}

async function accessToken(context: DeployContext): Promise<string | undefined> {
  const result = await probe(context, 'gcloud', ['auth', 'print-access-token']);
  const token = result.ok ? result.stdout.trim() : '';
  return token === '' ? undefined : token;
}

async function missingPermissions(
  fetchImpl: typeof fetch,
  project: string,
  token: string,
  required: readonly string[],
): Promise<readonly string[] | undefined> {
  try {
    const response = await fetchImpl(
      `https://cloudresourcemanager.googleapis.com/v3/projects/${project}:testIamPermissions`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ permissions: required }),
      },
    );
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    const permissions = field(body, 'permissions');
    const granted = new Set(Array.isArray(permissions) ? permissions : []);
    return required.filter((permission) => !granted.has(permission));
  } catch {
    return undefined;
  }
}

type Gcloud = (args: readonly string[]) => Promise<Probe>;

async function checkGcloud(context: DeployContext): Promise<GcpPreflightCheck> {
  const result = await probe(context, 'gcloud', ['--version']);
  return result.ok
    ? check('gcloud', 'The Google Cloud command line (gcloud) is installed', 'ok')
    : check(
        'gcloud',
        'The Google Cloud command line (gcloud) is not installed',
        'fail',
        GCLOUD_INSTALL_URL,
      );
}

/**
 * Terraform uses the Application Default Credentials; every gcloud command here (and the state
 * bucket's) uses gcloud's own account. A laptop needs both logins, so each has its own check.
 */
async function checkSignIn(
  gcloud: Gcloud,
): Promise<{ readonly checks: readonly GcpPreflightCheck[]; readonly accountSignedIn: boolean }> {
  const adc = await gcloud(['auth', 'application-default', 'print-access-token']);
  const account = await gcloud(['auth', 'print-access-token']);
  return {
    accountSignedIn: account.ok,
    checks: [
      adc.ok
        ? check('sign-in', 'You are signed in to Google Cloud', 'ok')
        : check('sign-in', 'You are not signed in to Google Cloud', 'fail', SIGN_IN),
      account.ok
        ? check('gcloud-account', 'The gcloud command line has an active account', 'ok')
        : check(
            'gcloud-account',
            'The gcloud command line has no active account',
            'fail',
            ACCOUNT_SIGN_IN,
          ),
    ],
  };
}

async function checkProject(
  gcloud: Gcloud,
  project: string,
  accountSignedIn: boolean,
): Promise<{ readonly check: GcpPreflightCheck; readonly number: string | undefined }> {
  const result = await gcloud(['projects', 'describe', project, '--format=value(projectNumber)']);
  const number = result.ok ? result.stdout.trim() : '';
  if (number === '' && !accountSignedIn) {
    return {
      number: undefined,
      check: check(
        'project',
        `Could not look up your Google Cloud project ${project} because gcloud has no active account`,
        'fail',
        ACCOUNT_SIGN_IN,
      ),
    };
  }
  return number === ''
    ? {
        number: undefined,
        check: check(
          'project',
          `Your Google Cloud project ${project} was not found or is not visible to you`,
          'fail',
          `gcloud projects create ${project}`,
        ),
      }
    : {
        number,
        check: check(
          'project',
          `Your Google Cloud project ${project} exists (number ${number})`,
          'ok',
        ),
      };
}

/** One command that grants the narrowest roles holding the missing permissions. */
function grantRoles(project: string, missing: readonly string[]): string {
  const roles = [...new Set(missing.map((permission) => ROLE_OF_PERMISSION[permission]))];
  return (
    `for role in ${roles.join(' ')}; do gcloud projects add-iam-policy-binding ${project} ` +
    '--member="user:$(gcloud config get-value account)" --role="$role"; done'
  );
}

async function checkPermissions(
  fetchImpl: typeof fetch,
  project: string,
  token: string | undefined,
  alertsEmail: string | undefined,
): Promise<GcpPreflightCheck> {
  const missing =
    token === undefined
      ? undefined
      : await missingPermissions(fetchImpl, project, token, requiredPermissions(alertsEmail));
  if (missing === undefined) {
    return check(
      'permissions',
      'Could not check what you may do in your Google Cloud project',
      'fail',
      token === undefined ? ACCOUNT_SIGN_IN : `gcloud projects describe ${project}`,
    );
  }
  if (missing.length === 0) {
    return check('permissions', 'You have every permission the deploy needs', 'ok');
  }
  return check(
    'permissions',
    `You lack ${String(missing.length)} permission(s) the deploy needs: ${missing.join(', ')}`,
    'fail',
    grantRoles(project, missing),
  );
}

async function checkBilling(gcloud: Gcloud, project: string): Promise<GcpPreflightCheck> {
  const result = await gcloud([
    'billing',
    'projects',
    'describe',
    project,
    '--format=value(billingEnabled)',
  ]);
  const answer = result.ok ? result.stdout.trim() : undefined;
  if (answer === 'True') {
    return check('billing', 'Billing is enabled on your Google Cloud project', 'ok');
  }
  if (answer === 'False') {
    return check(
      'billing',
      'Billing is not enabled on your Google Cloud project',
      'fail',
      `https://console.cloud.google.com/billing/linkedaccount?project=${project}`,
    );
  }
  return check('billing', 'Could not check whether billing is enabled', 'warn');
}

async function checkApis(
  gcloud: Gcloud,
  project: string,
): Promise<{ readonly check: GcpPreflightCheck; readonly missing: readonly string[] }> {
  const result = await gcloud([
    'services',
    'list',
    '--enabled',
    '--project',
    project,
    '--format=value(config.name)',
  ]);
  if (!result.ok) {
    return {
      missing: [],
      check: check(
        'apis',
        'Could not list the enabled Google Cloud APIs',
        'warn',
        `gcloud services list --enabled --project ${project}`,
      ),
    };
  }
  const enabled = new Set(result.stdout.split('\n').map((line) => line.trim()));
  const missing = REQUIRED_GCP_APIS.filter((api) => !enabled.has(api));
  if (missing.length === 0) {
    return {
      missing,
      check: check('apis', 'Every Google Cloud API the deploy needs is enabled', 'ok'),
    };
  }
  return {
    missing,
    check: check(
      'apis',
      `${String(missing.length)} Google Cloud API(s) still need enabling: ${missing.join(', ')}`,
      'warn',
      enableCommand(missing, project),
    ),
  };
}

const VERTEX_API = 'aiplatform.googleapis.com';

/** Vertex AI's endpoint host for each location Claude is served from. */
const VERTEX_HOSTS: Readonly<Record<VertexLocation, string>> = {
  global: 'aiplatform.googleapis.com',
  us: 'aiplatform.us.rep.googleapis.com',
  eu: 'aiplatform.eu.rep.googleapis.com',
};

const MODEL_NOT_ENABLED = /publisher model|model garden|not (?:been )?enabled|not allowed/iu;
const SERVICE_DISABLED = /service_disabled|has not been used|is disabled|accessnotconfigured/iu;

/** Google's `{error: {status, message}}` as one string; empty when the body is anything else. */
async function googleErrorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { status?: unknown; message?: unknown } };
    const { status, message } = body.error ?? {};
    return `${typeof status === 'string' ? status : ''} ${typeof message === 'string' ? message : ''}`;
  } catch {
    return '';
  }
}

/**
 * Whether Claude answers in this project: one 1-token `rawPredict`. Every outcome is a warning: the
 * deploy still works with an Anthropic key, and another Claude model may be enabled. Google documents no API that
 * reports Model Garden enablement or Claude quota, so asking the model is the only way to see
 * either. The token is sent and never printed.
 */
async function checkVertexModel(
  fetchImpl: typeof fetch,
  project: string,
  location: VertexLocation,
  token: string | undefined,
): Promise<GcpPreflightCheck> {
  const model = VERTEX_DEFAULT_MODEL;
  const unknown = check('vertex-model', `Could not check that Claude (${model}) answers`, 'warn');
  if (token === undefined) return unknown;
  const url =
    `https://${VERTEX_HOSTS[location]}/v1/projects/${project}/locations/${location}` +
    `/publishers/anthropic/models/${model}:rawPredict`;
  let httpStatus: number;
  let googleError = '';
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        anthropic_version: 'vertex-2023-10-16',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    httpStatus = response.status;
    if (httpStatus === 403 || httpStatus === 404) googleError = await googleErrorText(response);
  } catch {
    return unknown;
  }
  if (httpStatus === 200) {
    return check('vertex-model', `Claude (${model}) answers in ${location}`, 'ok');
  }
  if (httpStatus === 404 || (httpStatus === 403 && MODEL_NOT_ENABLED.test(googleError))) {
    return check(
      'vertex-model',
      `Claude ${model} is not enabled for your Google Cloud project; enable it before the first run`,
      'warn',
      `https://console.cloud.google.com/vertex-ai/publishers/anthropic/model-garden/${model}?project=${project}`,
    );
  }
  if (httpStatus === 403) {
    // The probe runs as the deployer, not as the gateway service account that serves the models,
    // so a refusal that is not about the model says nothing the deploy should stop for.
    const cause = SERVICE_DISABLED.test(googleError)
      ? 'the Vertex AI API was only just enabled; run the preflight again in a minute'
      : 'your account may lack aiplatform.endpoints.predict, which the gateway service account has';
    return check(
      'vertex-model',
      `Could not check that Claude (${model}) answers: ${cause}`,
      'warn',
    );
  }
  if (httpStatus === 429) {
    return check(
      'vertex-model',
      `The quota for Claude in ${location} is exhausted`,
      'warn',
      `https://console.cloud.google.com/iam-admin/quotas?project=${project}` +
        ` (filter by base_model anthropic-${model.replace(/-\d.*$/u, '')})`,
    );
  }
  return unknown;
}

function enableCommand(apis: readonly string[], project: string): string {
  return `gcloud services enable ${apis.join(' ')} --project ${project}`;
}

async function checkPublicAccessPolicy(
  context: DeployContext,
  project: string,
): Promise<GcpPreflightCheck> {
  const { enforced, unreadable } = await orgPolicies(context, project, [
    'iam.allowedPolicyMemberDomains',
    'iam.managed.allowedPolicyMembers',
  ]);
  if (enforced.length > 0) {
    return check(
      'org-policy-public-access',
      `Your organisation restricts who may be granted access (${enforced.join(', ')}); the web app's sign-in page and the gateway must be reachable by anyone (the gateway keeps an allUsers invoker binding whatever gcp.iap is). ` +
        `Ask your administrator for an exception for project ${project}`,
      'fail',
    );
  }
  return unreadable
    ? check(
        'org-policy-public-access',
        'Could not check the organisation policy on who may be granted access',
        'warn',
      )
    : check(
        'org-policy-public-access',
        'Your organisation lets the web app be reached publicly',
        'ok',
      );
}

async function checkPrivateNetworkPolicy(
  context: DeployContext,
  project: string,
  domain: string | undefined,
): Promise<GcpPreflightCheck> {
  // sql.restrictPublicIp is met: the database has a private address only.
  const { enforced, unreadable } = await orgPolicies(context, project, [
    'run.allowedIngress',
    'run.allowedVPCEgress',
  ]);
  const warnings = [
    ...(enforced.includes('run.allowedIngress')
      ? [
          `run.allowedIngress: the web app stays public${domain === undefined ? '' : ' (internal-and-cloud-load-balancing, behind the load balancer for ' + domain + ')'} and the runner manager is internal`,
        ]
      : []),
    ...(enforced.includes('run.allowedVPCEgress')
      ? ['run.allowedVPCEgress: the services use private-ranges-only']
      : []),
  ];
  if (warnings.length > 0) {
    return check(
      'org-policy-private-network',
      `Your organisation restricts Cloud Run networking; ${warnings.join('; ')}`,
      'warn',
    );
  }
  return unreadable
    ? check(
        'org-policy-private-network',
        'Could not check the organisation network policies',
        'warn',
      )
    : check(
        'org-policy-private-network',
        'Your organisation has no network policy that blocks the deploy',
        'ok',
      );
}

function resolvedAddresses(result: unknown): readonly string[] {
  const entries: unknown[] = Array.isArray(result) ? result : [result];
  return entries.flatMap((entry) =>
    typeof entry === 'object' &&
    entry !== null &&
    'address' in entry &&
    typeof entry.address === 'string'
      ? [entry.address]
      : [],
  );
}

/** Whether `domain` already points at the load balancer; before the first deploy there is no address yet, so it warns. */
async function checkDns(input: GcpPreflightInput): Promise<GcpPreflightCheck | null> {
  const { domain, loadBalancerIp, resolveHost } = input;
  if (domain === undefined || loadBalancerIp === undefined || resolveHost === undefined) {
    return null;
  }
  const ip = await loadBalancerIp();
  if (ip === null) {
    return check(
      'dns',
      `DNS for ${domain} cannot be checked yet: the load balancer address does not exist before the first deploy`,
      'warn',
      `after the deploy, create an A record for ${domain} that points at the printed address; the certificate is issued once it does`,
    );
  }
  let addresses: readonly string[] = [];
  try {
    addresses = resolvedAddresses(await resolveHost(domain));
  } catch {
    // A host name that does not resolve yet is the warning below, not a failure.
  }
  return addresses.includes(ip)
    ? check('dns', `DNS for ${domain} points at ${ip}`, 'ok')
    : check(
        'dns',
        `DNS for ${domain} does not point here yet (${ip}); the certificate is issued once it does`,
        'warn',
        `create this record at your DNS provider: ${domain}. A ${ip}`,
      );
}

async function checkTerraform(
  context: DeployContext,
  host: { readonly platform: string; readonly arch: string },
): Promise<GcpPreflightCheck> {
  const result = await probe(context, 'terraform', ['version', '-json']);
  const version = result.ok ? terraformVersion(result.stdout) : undefined;
  return version !== undefined && atLeast(version, MINIMUM_TERRAFORM)
    ? check('terraform', `Terraform ${version} is installed`, 'ok')
    : check(
        'terraform',
        `Terraform ${MINIMUM_TERRAFORM.join('.')} or newer is not installed`,
        'fail',
        terraformInstall(host.platform, host.arch),
      );
}

async function checkBuildx(context: DeployContext): Promise<GcpPreflightCheck> {
  const result = await probe(context, 'docker', ['buildx', 'version']);
  return result.ok
    ? check('docker-buildx', 'Docker buildx is available to copy the images', 'ok')
    : check(
        'docker-buildx',
        'Docker buildx is not available to copy the images',
        'fail',
        DOCKER_BUILDX_INSTALL,
      );
}

/** Run every Google Cloud check and report; see the module comment for what it may create. */
export async function runGcpPreflight(input: GcpPreflightInput): Promise<GcpPreflightReport> {
  const { context, project, region, apply } = input;
  const gcloud: Gcloud = (args) => probe(context, 'gcloud', args);
  const checks: GcpPreflightCheck[] = [];

  const signIn = await checkSignIn(gcloud);
  checks.push(await checkGcloud(context), ...signIn.checks);
  const found = await checkProject(gcloud, project, signIn.accountSignedIn);
  checks.push(found.check);
  const fetchImpl = input.fetch ?? fetch;
  const token = await accessToken(context);
  checks.push(
    await checkPermissions(fetchImpl, project, token, input.alertsEmail),
    await checkBilling(gcloud, project),
  );
  const apis = await checkApis(gcloud, project);
  const apisIndex = checks.length;
  checks.push(
    apis.check,
    check('vertex-model', 'Claude is checked once the Vertex AI API is enabled', 'warn'),
    await checkPublicAccessPolicy(context, project),
    await checkPrivateNetworkPolicy(context, project, input.domain),
    await checkTerraform(context, input.host ?? process),
    await checkBuildx(context),
  );
  const dns = await checkDns(input);
  if (dns !== null) checks.push(dns);

  const canEnable =
    apply && apis.missing.length > 0 && !checks.some((entry) => entry.status === 'fail');
  if (canEnable) {
    const enabled = await gcloud(['services', 'enable', ...apis.missing, '--project', project]);
    checks[apisIndex] = enabled.ok
      ? check(
          'apis',
          `Enabled ${String(apis.missing.length)} Google Cloud API(s): ${apis.missing.join(', ')}`,
          'fixed',
        )
      : check(
          'apis',
          'Enabling the Google Cloud APIs failed',
          'fail',
          enableCommand(apis.missing, project),
        );
  }

  if (!apis.missing.includes(VERTEX_API) || checks[apisIndex]?.status === 'fixed') {
    checks[apisIndex + 1] = await checkVertexModel(
      fetchImpl,
      project,
      input.modelLocation ?? 'global',
      token,
    );
  }

  return {
    project,
    region,
    ...(found.number === undefined ? {} : { projectNumber: found.number }),
    checks,
    passed: !checks.some((entry) => entry.status === 'fail'),
  };
}

const LABELS: Record<GcpPreflightStatus, string> = {
  ok: '[ ok  ]',
  fail: '[FAIL ]',
  warn: '[warn ]',
  fixed: '[fixed]',
};

/** The report as the lines the operator reads. */
export function renderPreflightReport(report: GcpPreflightReport): string {
  const lines = [`Checking your Google Cloud project ${report.project} (${report.region})`, ''];
  for (const entry of report.checks) {
    lines.push(`${LABELS[entry.status]} ${entry.title}`);
    if (entry.fix !== undefined) lines.push(`         fix: ${entry.fix}`);
  }
  lines.push(
    '',
    report.passed
      ? 'Every check passed; nothing was changed except what is marked fixed.'
      : 'Some checks failed. Nothing was created. Run the fix commands above and try again.',
  );
  return `${lines.join('\n')}\n`;
}
