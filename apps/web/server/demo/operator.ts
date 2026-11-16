/**
 * The one check every demo operator route makes (internal spec, "The GCP deployment"): the
 * deployment's own operator steps send `Authorization: Bearer <AW_DEMO_OPERATOR_TOKEN>`. While the
 * token is unset the route does not exist (`404`), so a deployment without it has no operator
 * surface; a request without the right token is `401`. The comparison is the cron routes' own
 * (`../http/cron.ts`), which takes the same time whatever the guess.
 *
 * The routes that use it: template seeding, the sample check and the verification workspace fill
 * (`provision/`), the maintenance flip and the readiness check (`maintenance/`).
 */
import type { DemoEntrySlug } from '@indx-workspace/contracts/demo';
import type {
  DemoMaintenanceRequest,
  DemoReadiness,
  DemoTemplateReports,
  DemoTemplateSeed,
} from '@indx-workspace/contracts/demo-operator';

import { bearerMatches, problem } from '../http/cron';

/** Why an operator request is refused, as the response to send; `null` when it may proceed. */
export function operatorRefusal(request: Request, token: string | null): Response | null {
  if (token === null) return problem(404, 'not_found', 'Not found.');
  if (!bearerMatches(request.headers.get('authorization'), token)) {
    return problem(401, 'unauthenticated', 'The operator token is missing or wrong.');
  }
  return null;
}

/**
 * Template seeding and the sample check (`PUT`/`GET /api/demo/templates`), built by the demo
 * provisioner's side (`provision/`). `null` where the deployment cannot hold a template (no
 * database, no file storage or no agent grants).
 */
export interface DemoTemplateOperations {
  /** Fill `entry`'s template from `seed`, making the template first if it is missing. */
  seed(input: {
    readonly entry: DemoEntrySlug;
    readonly seed: DemoTemplateSeed;
    readonly now: Date;
  }): Promise<{ readonly changed: boolean }>;
  /** Every template the deployment made, and what a visitor's copy would get from it. */
  report(): Promise<DemoTemplateReports>;
}

/**
 * The daily production test's verdicts (`PUT /api/demo/maintenance/{entry}`) and the store's read
 * of them (`GET /api/store/demos`). `null` where there is no database to keep them in.
 */
export interface DemoMaintenanceOperations {
  set(input: {
    readonly entry: DemoEntrySlug;
    readonly request: DemoMaintenanceRequest;
    readonly now: Date;
  }): Promise<void>;
  /** The entries under maintenance now, by slug. */
  underMaintenance(): Promise<readonly DemoEntrySlug[]>;
}

/** What filling a verification workspace came to (`PUT /api/demo/verification/{workspaceId}`). */
type DemoVerificationOutcome =
  | { readonly kind: 'filled'; readonly entries: readonly DemoEntrySlug[] }
  /** No workspace has the id (or it has no member). */
  | { readonly kind: 'workspace-not-found' }
  /** A visitor's demo workspace, a template, or a workspace with no Owner: never filled. */
  | { readonly kind: 'workspace-refused' };

/**
 * The real-model verification workspace fill (`provision/verification.ts`): every template copied
 * into an ordinary workspace as a visitor's demo copy is made. `null` where the deployment cannot
 * hold a template.
 */
export interface DemoVerificationOperations {
  fill(input: {
    readonly workspaceId: string;
    readonly now: Date;
  }): Promise<DemoVerificationOutcome>;
}

/** The deploy's read-only readiness check (`GET /api/demo/readiness`). */
export interface DemoReadinessCheck {
  check(): Promise<DemoReadiness>;
}

/** What the composition root installs as `ApplicationContext.demoOperator`. */
export interface DemoOperatorRuntime {
  /** `AW_DEMO_OPERATOR_TOKEN`; `null` while unset, and the operator routes then answer 404. */
  readonly token: string | null;
  readonly templates: DemoTemplateOperations | null;
  readonly verification: DemoVerificationOperations | null;
  readonly maintenance: DemoMaintenanceOperations | null;
  readonly readiness: DemoReadinessCheck | null;
}

/** The runtime of a context with no operator surface: every operator route answers 404. */
export const NO_DEMO_OPERATOR: DemoOperatorRuntime = {
  token: null,
  templates: null,
  verification: null,
  maintenance: null,
  readiness: null,
};
