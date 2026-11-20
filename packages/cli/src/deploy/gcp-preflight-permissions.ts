/** What the deployer may do in the project: the required permissions and the roles that grant them. */
import { field } from './gcp-json-fields.ts';
import {
  ACCOUNT_SIGN_IN,
  bearerHeaders,
  check,
  probe,
  type GcpPreflightCheck,
} from './gcp-preflight-check.ts';
import type { DeployContext } from './steps.ts';

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
  'iam.roles.create',
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
  'iam.roles.create': 'roles/iam.roleAdmin',
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

export async function accessToken(context: DeployContext): Promise<string | undefined> {
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
        headers: bearerHeaders(token, true),
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

/** One command that grants the narrowest roles holding the missing permissions. */
function grantRoles(project: string, missing: readonly string[]): string {
  const roles = [...new Set(missing.map((permission) => ROLE_OF_PERMISSION[permission]))];
  return (
    `for role in ${roles.join(' ')}; do gcloud projects add-iam-policy-binding ${project} ` +
    '--member="user:$(gcloud config get-value account)" --role="$role"; done'
  );
}

export async function checkPermissions(
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
