/**
 * The template operator routes (internal spec, "How Try it works" and "The GCP deployment"):
 * `PUT /api/demo/templates/{entry}` seeds one entry's template and `GET /api/demo/templates` reports
 * every template, for the deploy's seeding step and the nightly sample check;
 * `PUT /api/demo/verification/{workspaceId}` copies every template into the real-model verification
 * workspace. The route files under `app/api/demo/templates/` and `app/api/demo/verification/` call
 * these and nothing else.
 *
 * Each answers like every operator route: `404` while `AW_DEMO_OPERATOR_TOKEN` is unset, `401` for a
 * wrong token (`../operator.ts`), then, for a seed, `415`/`413`/`400` for a body that is not JSON, is
 * too large or is not a seed, and `400`/`409` for a seed that does not hold together or a slug that
 * is not the deployment's. A problem names the field and the rule, never the value sent.
 */
import { isUuid } from '@indx-workspace/contracts';
import { DemoEntrySlugSchema } from '@indx-workspace/contracts/demo';
import {
  DemoTemplateSeedSchema,
  type DemoVerificationFill,
} from '@indx-workspace/contracts/demo-operator';

import { problem } from '../../http/cron';
import { readBoundedJson } from '../../http/json-transport';
import { operatorRefusal, type DemoOperatorRuntime } from '../operator';
import { DEMO_SEED_BODY_MAX_BYTES } from './limits';
import { DemoSeedRefusal } from './seed';

const unavailable = (): Response =>
  problem(503, 'demo_templates_unavailable', 'This deployment cannot hold demo templates.');

export async function putDemoTemplate(
  request: Request,
  entryParam: string,
  runtime: DemoOperatorRuntime,
  now: Date,
): Promise<Response> {
  const refusal = operatorRefusal(request, runtime.token);
  if (refusal !== null) return refusal;
  const entry = DemoEntrySlugSchema.safeParse(entryParam);
  if (!entry.success)
    return problem(400, 'invalid_entry', 'The entry is not a catalog entry slug.');
  if (runtime.templates === null) return unavailable();
  const body = await readBoundedJson(request, {
    maxBytes: DEMO_SEED_BODY_MAX_BYTES,
    problem,
  });
  if (!body.ok) return body.result;
  const seed = DemoTemplateSeedSchema.safeParse(body.value);
  if (!seed.success) {
    const details = seed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    return Response.json(
      {
        error: {
          code: 'invalid_demo_seed',
          message: 'The body is not a demo template seed.',
          details,
        },
      },
      { status: 400 },
    );
  }
  try {
    const { changed } = await runtime.templates.seed({ entry: entry.data, seed: seed.data, now });
    return Response.json({ entry: entry.data, changed });
  } catch (error) {
    if (error instanceof DemoSeedRefusal) {
      return problem(error.code === 'demo_seed_invalid' ? 400 : 409, error.code, error.message);
    }
    throw error;
  }
}

/**
 * `PUT /api/demo/verification/{workspaceId}`: copy every template into that ordinary workspace as a
 * visitor's demo copy is made (`verification.ts`). No body. `400` for an id that is not one, `404`
 * for no such workspace, `409` for a demo workspace, a template or a workspace with no Owner.
 */
export async function putDemoVerification(
  request: Request,
  workspaceParam: string,
  runtime: DemoOperatorRuntime,
  now: Date,
): Promise<Response> {
  const refusal = operatorRefusal(request, runtime.token);
  if (refusal !== null) return refusal;
  if (!isUuid(workspaceParam)) {
    return problem(400, 'invalid_workspace_id', 'The workspace is not a workspace id.');
  }
  if (runtime.verification === null) return unavailable();
  const outcome = await runtime.verification.fill({ workspaceId: workspaceParam, now });
  if (outcome.kind === 'workspace-not-found') {
    return problem(404, 'verification_workspace_not_found', 'There is no such workspace.');
  }
  if (outcome.kind === 'workspace-refused') {
    return problem(
      409,
      'verification_workspace_refused',
      'The workspace is a demo or a template, or it has no Owner: it is not filled.',
    );
  }
  const body: DemoVerificationFill = { workspaceId: workspaceParam, entries: outcome.entries };
  return Response.json(body);
}

export async function getDemoTemplates(
  request: Request,
  runtime: DemoOperatorRuntime,
): Promise<Response> {
  const refusal = operatorRefusal(request, runtime.token);
  if (refusal !== null) return refusal;
  if (runtime.templates === null) return unavailable();
  return Response.json(await runtime.templates.report());
}
