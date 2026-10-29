import { z } from 'zod';

/** ADR-0160 D1: the switchable features, closed. `core` is always on and is not one. */
export const FEATURE_IDS = [
  'chat',
  'projects',
  'files',
  'skills',
  'connectors',
  'runs',
  'sharing',
  'surfaces',
  'triggers',
  'evaluations',
  'builder',
] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

/** What a route or navigation entry belongs to: a feature, or `core`. */
export const ROUTE_FEATURES = ['core', ...FEATURE_IDS] as const;
export type RouteFeature = (typeof ROUTE_FEATURES)[number];

export const FeatureIdSchema = z.enum(FEATURE_IDS);

/** ADR-0160 D3: what each feature needs switched on. Acyclic; checked by a test. */
export const FEATURE_DEPENDENCIES = {
  surfaces: ['chat'],
  triggers: ['runs'],
  evaluations: ['runs'],
} as const satisfies Partial<Record<FeatureId, readonly FeatureId[]>>;

const dependencies: Partial<Record<FeatureId, readonly FeatureId[]>> = FEATURE_DEPENDENCIES;
const DEPENDENCY_EDGES = FEATURE_IDS.flatMap((feature) =>
  (dependencies[feature] ?? []).map((need): readonly [FeatureId, FeatureId] => [feature, need]),
);

/** Every listed feature whose D3 dependency is not also listed. */
export function featuresMissingDependencies(
  ids: readonly FeatureId[],
): readonly { feature: FeatureId; needs: FeatureId }[] {
  return DEPENDENCY_EDGES.filter(
    ([feature, need]) => ids.includes(feature) && !ids.includes(need),
  ).map(([feature, needs]) => ({ feature, needs }));
}

/** The enabled features that need `id`, sorted: what switching `id` off would strand. */
export function dependentsOf(id: FeatureId, enabled: readonly FeatureId[]): readonly FeatureId[] {
  return DEPENDENCY_EDGES.filter(([feature, need]) => need === id && enabled.includes(feature))
    .map(([feature]) => feature)
    .sort();
}

/** ADR-0160 D5: a non-empty, duplicate-free list that holds every listed feature's dependencies. */
export const FeatureListSchema = z
  .array(FeatureIdSchema)
  .min(1)
  .superRefine((ids, ctx) => {
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: 'custom', message: 'features must not repeat' });
    }
    for (const { feature, needs } of featuresMissingDependencies(ids)) {
      ctx.addIssue({ code: 'custom', message: `${feature} needs ${needs}` });
    }
  })
  .readonly();

export const WorkspaceFeatureSchema = z
  .object({ id: FeatureIdSchema, installed: z.boolean(), enabled: z.boolean() })
  .strict();
export type WorkspaceFeature = z.infer<typeof WorkspaceFeatureSchema>;

/** ADR-0160 D8: `GET`/`PUT /workspaces/:id/features`; one row per `FEATURE_IDS` entry, in that order. */
export const WorkspaceFeaturesSchema = z
  .object({ features: z.array(WorkspaceFeatureSchema) })
  .strict()
  .superRefine(({ features }, ctx) => {
    const inOrder =
      features.length === FEATURE_IDS.length &&
      features.every((row, index) => row.id === FEATURE_IDS[index]);
    if (!inOrder) {
      ctx.addIssue({
        code: 'custom',
        path: ['features'],
        message: 'features must hold one row per feature, in FEATURE_IDS order',
      });
    }
  });
export type WorkspaceFeatures = z.infer<typeof WorkspaceFeaturesSchema>;

/** ADR-0160 D6: the whole "off" set for the workspace, not a patch. */
export const UpdateWorkspaceFeaturesRequestSchema = z
  .object({
    disabled: z.array(FeatureIdSchema).refine((ids) => new Set(ids).size === ids.length, {
      message: 'disabled must not repeat',
    }),
  })
  .strict();
export type UpdateWorkspaceFeaturesRequest = z.infer<typeof UpdateWorkspaceFeaturesRequestSchema>;

/** ADR-0160 D7: the refusals a feature switch adds, with their HTTP statuses. */
export const FEATURE_PROBLEM_CODES = {
  feature_disabled: 404,
  feature_in_use: 409,
  feature_not_installed: 409,
} as const;
export type FeatureProblemCode = keyof typeof FEATURE_PROBLEM_CODES;
