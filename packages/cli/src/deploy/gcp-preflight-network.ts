/** The organisation policies and the DNS record that decide whether the deployed web app is reachable. */
import { field } from './gcp-json-fields.ts';
import { check, probe, type GcpPreflightCheck } from './gcp-preflight-check.ts';
import type { DeployContext } from './steps.ts';

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

export async function checkPublicAccessPolicy(
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

export async function checkPrivateNetworkPolicy(
  context: DeployContext,
  project: string,
  domain: string | undefined,
): Promise<GcpPreflightCheck> {
  // sql.restrictPublicIp is met: the database has a private address only.
  const { enforced, unreadable } = await orgPolicies(context, project, [
    'run.allowedIngress',
    'run.allowedVPCEgress',
  ]);
  const behindBalancer =
    domain === undefined
      ? ''
      : ` (internal-and-cloud-load-balancing, behind the load balancer for ${domain})`;
  const warnings = [
    ...(enforced.includes('run.allowedIngress')
      ? [
          `run.allowedIngress: the web app stays public${behindBalancer} and the runner manager is internal`,
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

interface DnsCheckInput {
  readonly domain?: string;
  readonly loadBalancerIp?: () => Promise<string | null>;
  readonly resolveHost?: (hostname: string) => Promise<unknown>;
}

/** Whether `domain` already points at the load balancer; before the first deploy there is no address yet, so it warns. */
export async function checkDns(input: DnsCheckInput): Promise<GcpPreflightCheck | null> {
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
