import { json } from './router-http.js';
import type { ModelInfo } from './types.js';

/** Model-listing envelopes. OpenAI SDK clients call `models.list()` and parse `{object, data}`. */
const MODEL_FORMATS = ['anthropic', 'openai'] as const;
type ModelFormat = (typeof MODEL_FORMATS)[number];

/**
 * The header every Anthropic SDK request carries and no OpenAI SDK request does. It is the only
 * signal at this route that names the *client*, which is what decides the envelope (ADR-0068 D6).
 */
const ANTHROPIC_CLIENT_HEADER = 'anthropic-version';

function isModelFormat(value: string | null): value is ModelFormat {
  return value !== null && (MODEL_FORMATS as readonly string[]).includes(value);
}

/**
 * Which model-listing envelope this request wants (ADR-0068 D6).
 *
 * The envelope belongs to the *client*, not to the run's connection family: Claude Code reaches the
 * gateway through `ANTHROPIC_BASE_URL` on every family, including the three OpenAI ones, so keying
 * on the family would answer an OpenAI envelope to a client that cannot parse it. `anthropic-version`
 * is the discriminator — the Anthropic SDK always sends it and the OpenAI SDK never does — and
 * `Accept: application/json`, which both send identically, is not. An explicit `?format=` or
 * `x-gateway-model-format` overrides both.
 */
function modelListingFormat(request: Request): ModelFormat {
  const query = new URL(request.url).searchParams.get('format');
  if (isModelFormat(query)) return query;
  const header = request.headers.get('x-gateway-model-format');
  if (isModelFormat(header)) return header;
  return request.headers.has(ANTHROPIC_CLIENT_HEADER) ? 'anthropic' : 'openai';
}

/** Map the adapter's Anthropic-shaped catalogue onto OpenAI's `models.list()` envelope. */
function openAIModelListing(models: readonly ModelInfo[], providerId: string): unknown {
  return {
    object: 'list',
    data: models.map((model) => ({
      id: model.id,
      object: 'model',
      created: Math.max(0, Math.floor(Date.parse(model.created_at) / 1_000) || 0),
      owned_by: providerId,
    })),
  };
}

/** The adapter's catalogue in the envelope the requesting client can parse. */
export function modelListingResponse(
  request: Request,
  models: readonly ModelInfo[],
  providerId: string,
): Response {
  if (modelListingFormat(request) === 'openai') {
    return json(openAIModelListing(models, providerId));
  }
  return json({
    data: models,
    first_id: models.at(0)?.id ?? null,
    last_id: models.at(-1)?.id ?? null,
    has_more: false,
  });
}
