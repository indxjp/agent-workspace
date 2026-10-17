/**
 * The deployment default model (issue #506): the last, explicitly named layer of the run model
 * ladder (`../compose/run-request.ts#resolveModelForRun`).
 *
 * A deployment may name one default model id per model provider in `AW_DEPLOYMENT_DEFAULT_MODELS`,
 * a JSON object such as `{"anthropic":"claude-sonnet-4-5","openai":"gpt-5.1"}`. The ladder uses it
 * only when the agent names a model connection but no model, and neither the project nor the
 * workspace names a default: the run then gets the agent's connection plus this id for that
 * connection's provider. It is keyed by provider because the connection an agent names may be any
 * provider, so one id cannot fit every connection.
 *
 * Only the local launcher (`packages/embedded`) sets it; compose, helm and production postures
 * leave it unset, so it is absent there and an agent without a model is refused with a typed 422.
 *
 * The value is parsed once at startup. An invalid value is reported without echoing it and treated
 * as absent, which fails closed: runs are refused rather than given a guessed model.
 */
import { MODEL_PROVIDERS, type ModelProvider } from '@indx-workspace/contracts/runs';
import { z } from 'zod';

export const DEPLOYMENT_DEFAULT_MODELS_ENV = 'AW_DEPLOYMENT_DEFAULT_MODELS';

const MAX_MODEL_ID_LENGTH = 200;

const DeploymentDefaultModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_MODEL_ID_LENGTH)
  // No whitespace, control (Cc) or invisible format (Cf, e.g. U+200B, U+202E) characters, so an id
  // cannot pose as a look-alike of a real one in the UI or on a run row.
  .regex(/^[^\s\p{Cc}\p{Cf}]+$/u);

const deploymentDefaultModelsShape = {
  anthropic: DeploymentDefaultModelIdSchema.optional(),
  'anthropic-compatible': DeploymentDefaultModelIdSchema.optional(),
  openai: DeploymentDefaultModelIdSchema.optional(),
  'azure-openai': DeploymentDefaultModelIdSchema.optional(),
  'openai-compatible': DeploymentDefaultModelIdSchema.optional(),
} satisfies Record<ModelProvider, z.ZodOptional<typeof DeploymentDefaultModelIdSchema>>;

const DeploymentDefaultModelsSchema = z.strictObject(deploymentDefaultModelsShape);

/** The deployment's default model id per provider; a provider without one is absent. */
export type DeploymentDefaultModels = Readonly<z.infer<typeof DeploymentDefaultModelsSchema>>;

export type DeploymentDefaultModelsReadResult =
  | { readonly ok: true; readonly defaults: DeploymentDefaultModels }
  | { readonly ok: false; readonly reason: string };

/** A reason built from the issue's location and kind only, never from the value it rejected. */
function describeIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === 'unrecognized_keys') {
    return `it names a key that is not a model provider (expected only: ${MODEL_PROVIDERS.join(', ')})`;
  }
  const where = issue.path.length === 0 ? 'the value' : `the "${issue.path.join('.')}" entry`;
  switch (issue.code) {
    case 'invalid_type':
      return issue.path.length === 0
        ? 'the value is not a JSON object keyed by model provider'
        : `${where} is not a string`;
    case 'too_small':
      return `${where} is blank`;
    case 'too_big':
      return `${where} is longer than ${String(MAX_MODEL_ID_LENGTH)} characters`;
    case 'invalid_format':
      return `${where} contains whitespace, control or invisible format characters`;
    default:
      return `${where} is invalid (${issue.code})`;
  }
}

/**
 * Read `AW_DEPLOYMENT_DEFAULT_MODELS` from `env`. Unset or blank is an empty map (absent). A value
 * that is not JSON, or does not match the strict schema, is `ok: false` with a reason naming the
 * variable and the problem; the reason never contains the raw value.
 */
export function readDeploymentDefaultModels(
  env: Readonly<Record<string, string | undefined>>,
): DeploymentDefaultModelsReadResult {
  const raw = env[DEPLOYMENT_DEFAULT_MODELS_ENV];
  if (raw === undefined || raw.trim() === '') return { ok: true, defaults: {} };

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: `${DEPLOYMENT_DEFAULT_MODELS_ENV} is not valid JSON` };
  }

  const parsed = DeploymentDefaultModelsSchema.safeParse(json);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(describeIssue).join('; ');
    return { ok: false, reason: `${DEPLOYMENT_DEFAULT_MODELS_ENV} is invalid: ${problems}` };
  }
  return { ok: true, defaults: parsed.data };
}
