/**
 * `aw deploy status production` for a gcp-cloudrun stack: the versions, the revision health, the
 * data protection and the drift, gathered with read-only calls only. The state is read with
 * `terraform show -json`, the services with `gcloud run services describe`, and the drift with a
 * plan that does not lock the state and is never applied.
 */
import type { ProductionGcp } from '@indx-workspace/contracts/project-file';

import { CLI_VERSION } from '../version.ts';
import { createRedactor } from './redact.ts';
import { runStep, type DeployContext } from './steps.ts';
import { withPlanFile } from './terraform.ts';

/** What `aw deploy status production` found. */
export interface DeployStatusReport {
  /** The report, redacted, ready to print. */
  readonly text: string;
  /** Every service has its latest revision ready. */
  readonly ready: boolean;
  /** Whether a plan against the stack has changes. */
  readonly changes: boolean;
}

export interface StatusStack {
  readonly moduleDirectory: string;
  readonly variablesFile: string;
  readonly gcp: ProductionGcp;
  /** The module's `name` variable: the prefix of its Cloud Run services. */
  readonly name: string;
}

/** The Cloud Run services of the module: its Terraform resource name and its service-name suffix. */
const SERVICES = [
  { resource: 'web', suffix: 'web' },
  { resource: 'gateway', suffix: 'gateway' },
  { resource: 'runner_manager', suffix: 'runner-mgr' },
] as const;

const RUNTIME_IMAGE_ENV = 'AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK';

/** The member `key` of a JSON object, else `undefined`: parsed tool output is never trusted to have a shape. */
function field(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const member: unknown = Reflect.get(value, key);
  return member;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} did not print JSON.`, { cause: error });
  }
}

interface StateResource {
  readonly type: string;
  readonly name: string;
  readonly values: unknown;
}

/** Every managed resource in `terraform show -json`'s state, child modules included. */
function stateResources(stateJson: string): readonly StateResource[] {
  const state = parseJson(stateJson, '`terraform show -json`');
  const collect = (module: unknown): readonly StateResource[] => [
    ...asArray(field(module, 'resources')).flatMap((resource) => {
      const type = asString(field(resource, 'type'));
      const name = asString(field(resource, 'name'));
      const values = field(resource, 'values');
      return type === undefined || name === undefined || !isObject(values)
        ? []
        : [{ type, name, values }];
    }),
    ...asArray(field(module, 'child_modules')).flatMap(collect),
  ];
  return collect(field(field(state, 'values'), 'root_module'));
}

function mainContainer(values: unknown): unknown {
  return asArray(field(asArray(field(values, 'template'))[0], 'containers'))[0];
}

function containerImage(values: unknown): string | undefined {
  return asString(field(mainContainer(values), 'image'));
}

function containerEnv(values: unknown, name: string): string | undefined {
  for (const variable of asArray(field(mainContainer(values), 'env'))) {
    if (field(variable, 'name') === name) return asString(field(variable, 'value'));
  }
  return undefined;
}

function service(resources: readonly StateResource[], resource: string): StateResource | undefined {
  return resources.find(
    (entry) => entry.type === 'google_cloud_run_v2_service' && entry.name === resource,
  );
}

function versionLines(resources: readonly StateResource[]): readonly string[] {
  const images = SERVICES.map(({ resource, suffix }) => [
    suffix,
    containerImage(service(resources, resource)?.values) ?? 'not in the state',
  ]);
  const runtime =
    containerEnv(service(resources, 'runner_manager')?.values, RUNTIME_IMAGE_ENV) ??
    'not in the state';
  return [
    'Versions:',
    `  CLI        ${CLI_VERSION}`,
    ...images.map(([label, image]) => `  ${(label ?? '').padEnd(10)} ${image}`),
    `  runtime    ${runtime}`,
  ];
}

interface Health {
  readonly service: string;
  readonly ready: boolean;
  readonly detail: string;
}

/** Whether `gcloud run services describe --format=json` reports the latest revision ready. */
function healthOf(serviceName: string, describeJson: string): Health {
  const status = field(parseJson(describeJson, '`gcloud run services describe`'), 'status');
  const ready = asArray(field(status, 'conditions')).find(
    (condition) => field(condition, 'type') === 'Ready',
  );
  const latestReady = asString(field(status, 'latestReadyRevisionName'));
  const latestCreated = asString(field(status, 'latestCreatedRevisionName'));
  if (
    field(ready, 'status') === 'True' &&
    latestReady !== undefined &&
    latestReady === latestCreated
  ) {
    return { service: serviceName, ready: true, detail: latestReady };
  }
  const message = asString(field(ready, 'message')) ?? 'the service reports no Ready condition';
  const behind =
    latestReady === latestCreated
      ? ''
      : ` (latest ready ${latestReady ?? 'none'}, latest created ${latestCreated ?? 'none'})`;
  return { service: serviceName, ready: false, detail: `${message}${behind}` };
}

async function describeService(
  context: DeployContext,
  stack: StatusStack,
  serviceName: string,
): Promise<Health> {
  const result = await runStep(
    context,
    'gcloud',
    [
      'run',
      'services',
      'describe',
      serviceName,
      '--project',
      stack.gcp.project,
      '--region',
      stack.gcp.region,
      '--format=json',
    ],
    { show: false, accept: [0, 1] },
  );
  if (result.status !== 0) {
    const reason = result.stderr
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim();
    return { service: serviceName, ready: false, detail: reason ?? 'gcloud could not describe it' };
  }
  return healthOf(serviceName, result.stdout);
}

/** The data-protection switches in the state: one entry per resource that has one. */
function protectionOf(
  resources: readonly StateResource[],
): readonly (readonly [string, boolean])[] {
  return resources.flatMap(({ type, name, values }): readonly (readonly [string, boolean])[] => {
    const flag = (key: string, protectedWhen: boolean): readonly (readonly [string, boolean])[] =>
      typeof field(values, key) === 'boolean'
        ? [[`${type}.${name}`, field(values, key) === protectedWhen]]
        : [];
    if (type === 'google_sql_database_instance' || type === 'google_cloud_run_v2_service') {
      return flag('deletion_protection', true);
    }
    return type === 'google_storage_bucket' ? flag('force_destroy', false) : [];
  });
}

function protectionLine(resources: readonly StateResource[]): string {
  const entries = protectionOf(resources);
  const unprotected = entries.filter(([, isProtected]) => !isProtected).map(([label]) => label);
  if (entries.length === 0)
    return 'Data protection: unknown (the state holds no protected resource)';
  if (unprotected.length === 0) return 'Data protection: on';
  if (unprotected.length === entries.length) return 'Data protection: off';
  return `Data protection: partial (off for ${unprotected.join(', ')})`;
}

const UNCHANGING_ACTIONS: ReadonlySet<unknown> = new Set(['no-op', 'read']);

/** How many resource and output changes `terraform show -json <planfile>` holds that are not no-ops. */
function planChangeCount(planJson: string): { applyable: boolean | undefined; count: number } {
  const plan = parseJson(planJson, '`terraform show -json`');
  if (field(plan, 'format_version') === undefined) {
    throw new Error('`terraform show -json` did not print a plan.');
  }
  const changing = (changes: readonly unknown[]): number =>
    changes.filter((change) =>
      asArray(field(change, 'actions')).some((action) => !UNCHANGING_ACTIONS.has(action)),
    ).length;
  const applyable = field(plan, 'applyable');
  const outputs = field(plan, 'output_changes');
  return {
    applyable: typeof applyable === 'boolean' ? applyable : undefined,
    count:
      changing(asArray(field(plan, 'resource_changes')).map((entry) => field(entry, 'change'))) +
      changing(isObject(outputs) ? Object.keys(outputs).map((key) => field(outputs, key)) : []),
  };
}

/**
 * A plan that locks nothing, read back as `deployWithTerraform` reads it: exit status 2 is
 * drift, and a 0 is confirmed from the plan file because a wrapper may exit 0 for Terraform's 2.
 */
async function driftOf(context: DeployContext, stack: StatusStack): Promise<number> {
  const chdir = `-chdir=${stack.moduleDirectory}`;
  return withPlanFile(async (planFile) => {
    const plan = await runStep(
      context,
      'terraform',
      [
        chdir,
        'plan',
        '-input=false',
        '-lock=false',
        '-detailed-exitcode',
        `-var-file=${stack.variablesFile}`,
        `-out=${planFile}`,
      ],
      { show: false, accept: [0, 2] },
    );
    const shown = planChangeCount(
      (await runStep(context, 'terraform', [chdir, 'show', '-json', planFile], { show: false }))
        .stdout,
    );
    if (plan.status === 2) return Math.max(1, shown.count);
    return (shown.applyable ?? shown.count > 0) ? Math.max(1, shown.count) : 0;
  });
}

/**
 * Gather the status of the stack. Reads only: `terraform show`, `terraform plan -lock=false` and
 * `gcloud run services describe`.
 */
export async function gatherStatus(
  context: DeployContext,
  stack: StatusStack,
): Promise<DeployStatusReport> {
  const state = await runStep(
    context,
    'terraform',
    [`-chdir=${stack.moduleDirectory}`, 'show', '-json'],
    { show: false },
  );
  const resources = stateResources(state.stdout);
  const health: Health[] = [];
  for (const { suffix } of SERVICES) {
    health.push(await describeService(context, stack, `${stack.name}-${suffix}`));
  }
  const drift = await driftOf(context, stack);
  const ready = health.every((entry) => entry.ready);
  const lines = [
    ...versionLines(resources),
    'Revision health:',
    ...health.map(
      ({ service: name, ready: isReady, detail }) =>
        `  ${name.padEnd(`${stack.name}-runner-mgr`.length)}  ${isReady ? 'ready' : 'NOT READY'}  ${detail}`,
    ),
    protectionLine(resources),
    drift === 0
      ? 'Drift: none'
      : `Drift: ${String(drift)} change(s); aw deploy production shows them`,
  ];
  return { text: `${createRedactor({})(lines.join('\n'))}\n`, ready, changes: drift > 0 };
}
