import { field, isJson } from './gcp-json-fields.ts';
import { runStep, type DeployContext } from './steps.ts';

/** The resource kinds whose deletion or replacement loses data. */
const PROTECTED_KINDS: ReadonlyMap<string, string> = new Map([
  ['google_sql_database_instance', 'Cloud SQL instance'],
  ['google_storage_bucket', 'storage bucket'],
]);

const IDLE_COST_LINES = {
  small:
    'Idle cost: small: Cloud SQL shared-core, one warm web instance and the gateway internal load balancer are the idle costs',
  standard:
    'Idle cost: standard: regional high-availability Cloud SQL (db-custom-2-7680), at least one warm instance of every service and the gateway internal load balancer are the idle costs',
} as const;

/** Added to the idle cost line when the plan sets `sandbox_internet`; no figure, the prices are Google's. */
const SANDBOX_INTERNET_COST =
  ' plus one small Compute Engine VM (the sandbox egress proxy) and one Cloud NAT gateway at list price (https://cloud.google.com/products/compute/pricing, https://cloud.google.com/nat/pricing)';

type PlanAction = 'create' | 'update' | 'delete' | 'replace';

const PLAN_ACTIONS: readonly PlanAction[] = ['create', 'update', 'delete', 'replace'];

/** `change.actions` as one of the four the summary counts; `null` for no-op, read and the unknown. */
function planAction(actions: unknown): PlanAction | null {
  if (!Array.isArray(actions)) return null;
  const joined = actions.join(',');
  if (joined === 'create' || joined === 'update' || joined === 'delete') return joined;
  return joined === 'delete,create' || joined === 'create,delete' ? 'replace' : null;
}

interface PlanChange {
  readonly address: string;
  readonly kind: string;
  readonly action: PlanAction;
}

/** The plan's `size` variable (`variables.size.value`); `small`, the module's default, when absent. */
function planSize(planJson: string): keyof typeof IDLE_COST_LINES {
  const plan: unknown = JSON.parse(planJson);
  const variables = isJson(plan) ? plan['variables'] : undefined;
  const size =
    isJson(variables) && isJson(variables['size']) ? variables['size']['value'] : undefined;
  return size === 'standard' ? 'standard' : 'small';
}

/** Whether the plan's `sandbox_internet` variable is true; false, the module's default, when absent. */
function planSandboxInternet(planJson: string): boolean {
  const plan: unknown = JSON.parse(planJson);
  const variables = isJson(plan) ? plan['variables'] : undefined;
  return (
    isJson(variables) &&
    isJson(variables['sandbox_internet']) &&
    variables['sandbox_internet']['value'] === true
  );
}

function planChanges(planJson: string): readonly PlanChange[] {
  let plan: unknown;
  try {
    plan = JSON.parse(planJson);
  } catch (error) {
    throw new Error('`terraform show -json` did not print a plan', { cause: error });
  }
  const changes = isJson(plan) ? plan['resource_changes'] : undefined;
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((entry: unknown): PlanChange[] => {
    if (!isJson(entry) || !isJson(entry['change'])) return [];
    const action = planAction(entry['change']['actions']);
    const { address, type } = entry;
    return action !== null && typeof address === 'string' && typeof type === 'string'
      ? [{ address, kind: type, action }]
      : [];
  });
}

/**
 * The plan in four lines a person can act on: counts by action, counts by resource kind, any
 * protected resource (Cloud SQL, a bucket) that would be deleted or replaced, and the idle cost
 * class. `planJson` is `terraform show -json <planfile>`; nothing in it is printed but addresses.
 */
export function summarisePlan(planJson: string): string {
  const changes = planChanges(planJson);
  const total = (action: PlanAction) => changes.filter((entry) => entry.action === action).length;
  const kinds = [...new Set(changes.map(({ kind }) => kind))].sort();
  const lines = [
    'Plan summary',
    `  ${PLAN_ACTIONS.map((action) => `${String(total(action))} to ${action}`).join(', ')}`,
    '  By resource kind:',
    ...(kinds.length === 0 ? ['    nothing'] : []),
    ...kinds.map((kind) => {
      const counts = PLAN_ACTIONS.flatMap((action) => {
        const count = changes.filter(
          (entry) => entry.kind === kind && entry.action === action,
        ).length;
        return count === 0 ? [] : [`${String(count)} ${action}`];
      });
      return `    ${kind}: ${counts.join(', ')}`;
    }),
  ];
  const lost = changes.filter(
    ({ kind, action }) =>
      PROTECTED_KINDS.has(kind) && (action === 'delete' || action === 'replace'),
  );
  lines.push(
    ...(lost.length === 0
      ? ['  Protected resources: none would be deleted or replaced']
      : lost.map(
          ({ address, kind, action }) =>
            `  PROTECTED: ${address} (${PROTECTED_KINDS.get(kind) ?? kind}) would be ${action === 'replace' ? 'replaced' : 'deleted'}; its data is lost`,
        )),
    `  ${IDLE_COST_LINES[planSize(planJson)]}${planSandboxInternet(planJson) ? SANDBOX_INTERNET_COST : ''}`,
  );
  return `${lines.join('\n')}\n`;
}

/** Whether the plan creates the web service, so a first deploy that must seed a model connection. */
export function planCreatesWeb(planJson: string): boolean {
  return planChanges(planJson).some(
    ({ address, kind, action }) =>
      kind === 'google_cloud_run_v2_service' &&
      address === 'google_cloud_run_v2_service.web' &&
      action === 'create',
  );
}

/** Print {@link summarisePlan} of the plan file at `planFile`, and return the plan's JSON. */
export async function showPlanSummary(
  context: DeployContext,
  moduleDirectory: string,
  planFile: string,
): Promise<string> {
  const shown = await runStep(
    context,
    'terraform',
    [`-chdir=${moduleDirectory}`, 'show', '-json', planFile],
    { show: false },
  );
  context.out(summarisePlan(shown.stdout));
  return shown.stdout;
}

/**
 * The protected resources the plan deletes, as human labels: a Cloud SQL instance or a Cloud Run
 * service with `deletion_protection` on, and a bucket without `force_destroy`. Terraform refuses
 * only inside the delete call, after it has destroyed other resources, so this is read from the
 * plan before anything is applied. `planJson` is `terraform show -json <planfile>`.
 */
export function protectedDeletions(planJson: string): readonly string[] {
  let plan: unknown;
  try {
    plan = JSON.parse(planJson);
  } catch {
    return [];
  }
  const changes = field(plan, 'resource_changes');
  if (!Array.isArray(changes)) return [];
  const labels: string[] = [];
  const entries: readonly unknown[] = changes;
  for (const entry of entries) {
    const change = field(entry, 'change');
    if (planAction(field(change, 'actions')) !== 'delete') continue;
    const before = field(change, 'before');
    const type = field(entry, 'type');
    const protectedNow = hasDeletionProtection(type, before);
    if (protectedNow) {
      const kind = PROTECTED_KINDS.get(String(type)) ?? 'Cloud Run service';
      labels.push(`${String(field(entry, 'address'))} (${kind})`);
    }
  }
  return labels;
}

function hasDeletionProtection(type: unknown, before: unknown): boolean {
  if (type === 'google_storage_bucket') return field(before, 'force_destroy') === false;
  if (type === 'google_cloud_run_v2_service') return field(before, 'deletion_protection') === true;
  if (type !== 'google_sql_database_instance') return false;
  const settings = field(before, 'settings');
  return (
    field(before, 'deletion_protection') === true ||
    (Array.isArray(settings) && field(settings[0], 'deletion_protection_enabled') === true)
  );
}
