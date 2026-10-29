/**
 * The workspace feature-switch use case (ADR-0160 D6–D8): what `GET`/`PUT
 * /api/workspaces/:id/features` answers once the route has proved who may ask. Pure apart from the
 * injected repository and audit sink.
 */
import {
  FEATURE_IDS,
  FEATURE_PROBLEM_CODES,
  UpdateWorkspaceFeaturesRequestSchema,
  featuresMissingDependencies,
  type FeatureId,
  type FeatureProblemCode,
  type WorkspaceFeatures,
} from '@indx-workspace/contracts/features';

import { formatIssues, problem, type ApiResult } from '../http/result';
import type { WorkspaceFeatureStore, WorkspaceFeaturesAuditEvent } from './features-runtime';

export interface WorkspaceFeaturesActor {
  readonly principalId: string;
  readonly userId: string;
  readonly label: string;
}

export interface UpdateWorkspaceFeaturesInput {
  readonly deployment: readonly FeatureId[];
  readonly repository: WorkspaceFeatureStore;
  readonly recordAudit: (event: WorkspaceFeaturesAuditEvent) => Promise<void>;
  /** Ensure the workspace's Builder; called after a write that switched `builder` on. */
  readonly provisionBuilder: () => Promise<void>;
  readonly workspaceId: string;
  readonly actor: WorkspaceFeaturesActor;
  readonly body: unknown;
}

export function listWorkspaceFeatures(
  deployment: readonly FeatureId[],
  disabled: readonly FeatureId[],
): WorkspaceFeatures {
  return {
    features: FEATURE_IDS.map((id) => {
      const installed = deployment.includes(id);
      return { id, installed, enabled: installed && !disabled.includes(id) };
    }),
  };
}

function featureProblem(
  code: FeatureProblemCode,
  message: string,
  details: readonly string[],
): ApiResult {
  return problem(FEATURE_PROBLEM_CODES[code], code, message, details);
}

export async function updateWorkspaceFeatures(
  input: UpdateWorkspaceFeaturesInput,
): Promise<ApiResult> {
  const { deployment, repository, workspaceId, actor } = input;
  const parsed = UpdateWorkspaceFeaturesRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return problem(
      400,
      'invalid_body',
      'The body must be { "disabled": [feature id, …] } with no repeats.',
      formatIssues(parsed.error.issues),
    );
  }
  const { disabled } = parsed.data;

  const missing = FEATURE_IDS.filter((id) => !deployment.includes(id) && !disabled.includes(id));
  if (missing.length > 0) {
    return featureProblem(
      'feature_not_installed',
      'This deployment does not install every feature the body would switch on.',
      missing,
    );
  }

  const enabled = deployment.filter((id) => !disabled.includes(id));
  const stranded = featuresMissingDependencies(enabled).map(({ feature }) => `feature:${feature}`);
  if (stranded.length > 0) {
    return featureProblem(
      'feature_in_use',
      'A feature that stays on needs one the body would switch off.',
      [...new Set(stranded)].sort(),
    );
  }

  // `before` comes from inside the replace's transaction, so two concurrent PUTs each audit what
  // they changed rather than both comparing against the set they read before either wrote.
  const { before, after } = await repository.replaceDisabled(disabled);
  if (before.length !== after.length || before.some((id, index) => id !== after[index])) {
    await input.recordAudit({
      workspaceId,
      actorPrincipalId: actor.principalId,
      actorUserId: actor.userId,
      actorLabel: actor.label,
      action: 'workspace-features-changed',
      subjectId: null,
      subjectLabel: after.length === 0 ? 'Features: all on' : `Features off: ${after.join(', ')}`,
    });
  }
  // An uninstalled feature must be in `disabled` (refused above), so `after` lacking `builder` means on.
  if (before.includes('builder') && !after.includes('builder')) await input.provisionBuilder();
  return { status: 200, body: listWorkspaceFeatures(deployment, after) };
}
