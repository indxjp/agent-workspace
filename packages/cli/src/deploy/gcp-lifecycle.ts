import type { VertexLocation } from '@indx-workspace/contracts/models';
import type { ProductionGcp } from '@indx-workspace/contracts/project-file';
import {
  renderPreflightReport,
  runGcpPreflight,
  type GcpPreflightReport,
} from './gcp-preflight.ts';
import { type DeployContext } from './steps.ts';

/**
 * Check the Google Cloud project before anything is created and print the report. With `only`, just
 * those checks decide (the destroy path needs the tools, the sign-in and the project, not billing).
 *
 * @throws {Error} when a check failed.
 */
export async function runPreflight(
  context: DeployContext,
  gcp: ProductionGcp,
  apply: boolean,
  {
    only,
    fetch,
    loadBalancerIp,
    resolveHost,
  }: {
    readonly only?: readonly string[];
    readonly fetch?: typeof globalThis.fetch;
    readonly loadBalancerIp?: () => Promise<string | null>;
    readonly resolveHost?: (hostname: string) => Promise<unknown>;
  } = {},
): Promise<void> {
  const full = await runGcpPreflight({
    context,
    project: gcp.project,
    region: gcp.region,
    apply,
    ...(gcp.modelLocation === undefined ? {} : { modelLocation: gcp.modelLocation }),
    ...(fetch === undefined ? {} : { fetch }),
    ...(gcp.domain === undefined ? {} : { domain: gcp.domain }),
    ...(gcp.iap === undefined ? {} : { iap: gcp.iap }),
    ...(gcp.alertsEmail === undefined ? {} : { alertsEmail: gcp.alertsEmail }),
    ...(loadBalancerIp === undefined ? {} : { loadBalancerIp }),
    ...(resolveHost === undefined ? {} : { resolveHost }),
  });
  const checks =
    only === undefined ? full.checks : full.checks.filter(({ id }) => only.includes(id));
  const report: GcpPreflightReport = {
    ...full,
    checks,
    passed: !checks.some(({ status }) => status === 'fail'),
  };
  context.out(renderPreflightReport(report));
  if (!report.passed) {
    throw new Error('The Google Cloud checks failed. Nothing was created.');
  }
}

export { deployRerunCommand, lifecycleStep } from './gcp-lifecycle-step.ts';

export {
  appVariables,
  assertNoConflictingVariables,
  expectedImageRegistry,
  legacyVariablesNotice,
  moduleResourceName,
  writeProjectVariables,
} from './gcp-project-variables.ts';

export {
  backendFor,
  backendRecord,
  ensureStateBucket,
  initialiseBackend,
  stateBucketName,
} from './gcp-state-backend.ts';
export type { StateBackend } from './gcp-state-backend.ts';

export { oidcClientSecretId, storeOidcClientSecret } from './gcp-oidc-secret.ts';

export {
  applyDatabase,
  applyFoundation,
  copyWhileCreatingDatabase,
  holdsDatabase,
} from './gcp-staged-apply.ts';

export { planCreatesWeb, showPlanSummary, summarisePlan } from './gcp-plan.ts';

export { seedVertexConnection } from './gcp-vertex-setup.ts';

export { readAppUrls, readOwnerPassword, readTerraformOutput } from './gcp-outputs.ts';

export { destroyStack } from './gcp-stack-destroy.ts';

export type StateBucketOutcome = 'exists' | 'created' | 'missing';

export interface OidcSecretInput {
  readonly moduleDirectory: string;
  readonly variablesFile: string;
  readonly project: string;
  readonly secretId: string;
  /** The `gcp.oidc` the stored value must belong to: a new issuer or client id asks again. */
  readonly oidc: { readonly issuer: string; readonly clientId: string };
  readonly env: NodeJS.ProcessEnv;
  /** Asks without echo; given only when the terminal is interactive. */
  readonly readSecret?: (question: string) => Promise<string>;
}

export interface VertexSeed {
  readonly webUrl: string;
  readonly adminEmail: string;
  readonly location: VertexLocation;
  /** Reads the Owner's password when the request is made; held in memory only. */
  readonly password: () => Promise<string>;
  readonly fetch?: typeof fetch;
  /** Waits between tries; the suite injects a stub. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
}
