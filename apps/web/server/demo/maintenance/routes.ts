/**
 * The maintenance routes (internal spec, "The GCP deployment"): `PUT /api/demo/maintenance/{entry}`
 * and `GET /api/demo/readiness` for the deployment's operator (bearer `AW_DEMO_OPERATOR_TOKEN`), and
 * the public `GET /api/store/demos` the store reads for its cards and Try tabs.
 */
import { DemoEntrySlugSchema, type StoreDemoStates } from '@indx-workspace/contracts/demo';
import { DemoMaintenanceRequestSchema } from '@indx-workspace/contracts/demo-operator';

import { formatIssues, noStoreResultResponse, problem, readJsonBody } from '../../http/result';
import { operatorRefusal, type DemoOperatorRuntime } from '../operator';

/** The largest maintenance body read, in bytes: a state and a reason of at most 500 characters. */
export const MAX_BODY_BYTES = 4 * 1024;

/** `PUT /api/demo/maintenance/{entry}`: `204` once the verdict is kept. */
export async function putDemoMaintenance(
  request: Request,
  entry: string,
  runtime: DemoOperatorRuntime,
  now: () => Date,
): Promise<Response> {
  const refused = operatorRefusal(request, runtime.token);
  if (refused !== null) return refused;
  const slug = DemoEntrySlugSchema.safeParse(entry);
  if (!slug.success) {
    return noStoreResultResponse(problem(404, 'not_found', 'There is no such demo entry.'));
  }
  const body = await readJsonBody(request, MAX_BODY_BYTES);
  if (!body.ok) return noStoreResultResponse(body.result);
  const parsed = DemoMaintenanceRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return noStoreResultResponse(
      problem(
        400,
        'invalid_body',
        'The request body is not valid.',
        formatIssues(parsed.error.issues),
      ),
    );
  }
  if (runtime.maintenance === null) {
    return noStoreResultResponse(
      problem(503, 'unavailable', 'This deployment keeps no maintenance verdicts.'),
    );
  }
  await runtime.maintenance.set({ entry: slug.data, request: parsed.data, now: now() });
  return noStoreResultResponse({ status: 204, body: null });
}

/** `GET /api/demo/readiness`: the two read-only checks, never the key. */
export async function getDemoReadiness(
  request: Request,
  runtime: DemoOperatorRuntime,
): Promise<Response> {
  const refused = operatorRefusal(request, runtime.token);
  if (refused !== null) return refused;
  if (runtime.readiness === null) {
    return noStoreResultResponse(
      problem(503, 'unavailable', 'This deployment has no readiness check.'),
    );
  }
  return noStoreResultResponse({ status: 200, body: await runtime.readiness.check() });
}

/** `GET /api/store/demos`: the entries under maintenance; public, and none where there is no database. */
export async function getStoreDemos(runtime: DemoOperatorRuntime | null): Promise<Response> {
  const maintenance = (await runtime?.maintenance?.underMaintenance()) ?? [];
  const body: StoreDemoStates = { maintenance };
  return noStoreResultResponse({ status: 200, body });
}
