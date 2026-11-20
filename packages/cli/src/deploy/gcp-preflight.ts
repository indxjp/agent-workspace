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
import type { VertexLocation } from '@indx-workspace/contracts/models';

import { checkApis, checkBilling, checkProject, checkSignIn } from './gcp-preflight-account.ts';
import {
  check,
  enableCommand,
  probe,
  type Gcloud,
  type GcpPreflightCheck,
  type GcpPreflightStatus,
} from './gcp-preflight-check.ts';
import {
  checkDns,
  checkPrivateNetworkPolicy,
  checkPublicAccessPolicy,
} from './gcp-preflight-network.ts';
import {
  accessToken,
  checkPermissions,
  REQUIRED_GCP_APIS,
  REQUIRED_GCP_PERMISSIONS,
} from './gcp-preflight-permissions.ts';
import { checkWebSecrets } from './gcp-preflight-secrets.ts';
import {
  checkBuildx,
  checkGcloud,
  checkTerraform,
  type DeployHost,
} from './gcp-preflight-tools.ts';
import { checkVertexModel, VERTEX_API } from './gcp-preflight-vertex.ts';
import type { DeployContext } from './steps.ts';

export { REQUIRED_GCP_APIS, REQUIRED_GCP_PERMISSIONS };

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
  /** `gcp.secretSettings`: the Secret Manager secret ids web reads; each must hold a version. */
  readonly webSecrets?: readonly string[];
  /** The machine the tools run on; the Terraform install fix is chosen for it. */
  readonly host?: DeployHost;
}

/** Enable `missing` APIs; the check that replaces the "still need enabling" warning. */
async function enableMissingApis(
  gcloud: Gcloud,
  project: string,
  missing: readonly string[],
): Promise<GcpPreflightCheck> {
  const enabled = await gcloud(['services', 'enable', ...missing, '--project', project]);
  return enabled.ok
    ? check(
        'apis',
        `Enabled ${String(missing.length)} Google Cloud API(s): ${missing.join(', ')}`,
        'fixed',
      )
    : check(
        'apis',
        'Enabling the Google Cloud APIs failed',
        'fail',
        enableCommand(missing, project),
      );
}

function hasFailure(checks: readonly GcpPreflightCheck[]): boolean {
  return checks.some((entry) => entry.status === 'fail');
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
  if (input.webSecrets !== undefined && input.webSecrets.length > 0) {
    checks.push(await checkWebSecrets(fetchImpl, project, token, input.webSecrets));
  }

  if (apply && apis.missing.length > 0 && !hasFailure(checks)) {
    checks[apisIndex] = await enableMissingApis(gcloud, project, apis.missing);
  }
  if (!apis.missing.includes(VERTEX_API) || checks[apisIndex]?.status === 'fixed') {
    const location = input.modelLocation ?? 'global';
    checks[apisIndex + 1] = await checkVertexModel(fetchImpl, project, location, token);
  }

  return {
    project,
    region,
    ...(found.number === undefined ? {} : { projectNumber: found.number }),
    checks,
    passed: !hasFailure(checks),
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
