/** Whether Claude answers on Vertex AI in the project. */
import { VERTEX_DEFAULT_MODEL, type VertexLocation } from '@indx-workspace/contracts/models';

import { bearerHeaders, check, type GcpPreflightCheck } from './gcp-preflight-check.ts';

export const VERTEX_API = 'aiplatform.googleapis.com';

/** Vertex AI's endpoint host for each location Claude is served from. */
const VERTEX_HOSTS: Readonly<Record<VertexLocation, string>> = {
  global: 'aiplatform.googleapis.com',
  us: 'aiplatform.us.rep.googleapis.com',
  eu: 'aiplatform.eu.rep.googleapis.com',
};

const MODEL_NOT_ENABLED = /publisher model|model garden|not (?:been )?enabled|not allowed/iu;
const SERVICE_DISABLED = /service_disabled|has not been used|is disabled|accessnotconfigured/iu;

/** Google's `{error: {status, message}}` as one string; empty when the body is anything else. */
async function googleErrorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { status?: unknown; message?: unknown } };
    const { status, message } = body.error ?? {};
    return `${typeof status === 'string' ? status : ''} ${typeof message === 'string' ? message : ''}`;
  } catch {
    return '';
  }
}

interface RawPredictAnswer {
  readonly httpStatus: number;
  readonly googleError: string;
}

/** The answer to one 1-token `rawPredict`, or `undefined` when the request itself failed. */
async function rawPredict(
  fetchImpl: typeof fetch,
  project: string,
  location: VertexLocation,
  token: string,
): Promise<RawPredictAnswer | undefined> {
  const url =
    `https://${VERTEX_HOSTS[location]}/v1/projects/${project}/locations/${location}` +
    `/publishers/anthropic/models/${VERTEX_DEFAULT_MODEL}:rawPredict`;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: bearerHeaders(token, true),
      body: JSON.stringify({
        anthropic_version: 'vertex-2023-10-16',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    const refused = response.status === 403 || response.status === 404;
    return {
      httpStatus: response.status,
      googleError: refused ? await googleErrorText(response) : '',
    };
  } catch {
    return undefined;
  }
}

/** The probe runs as the deployer, not as the gateway service account that serves the models. */
function forbiddenCheck(model: string, googleError: string): GcpPreflightCheck {
  // A refusal that is not about the model says nothing the deploy should stop for.
  const cause = SERVICE_DISABLED.test(googleError)
    ? 'the Vertex AI API was only just enabled; run the preflight again in a minute'
    : 'your account may lack aiplatform.endpoints.predict, which the gateway service account has';
  return check('vertex-model', `Could not check that Claude (${model}) answers: ${cause}`, 'warn');
}

/**
 * Whether Claude answers in this project: one 1-token `rawPredict`. Every outcome is a warning: the
 * deploy still works with an Anthropic key, and another Claude model may be enabled. Google documents no API that
 * reports Model Garden enablement or Claude quota, so asking the model is the only way to see
 * either. The token is sent and never printed.
 */
export async function checkVertexModel(
  fetchImpl: typeof fetch,
  project: string,
  location: VertexLocation,
  token: string | undefined,
): Promise<GcpPreflightCheck> {
  const model = VERTEX_DEFAULT_MODEL;
  const unknown = check('vertex-model', `Could not check that Claude (${model}) answers`, 'warn');
  if (token === undefined) return unknown;
  const answer = await rawPredict(fetchImpl, project, location, token);
  if (answer === undefined) return unknown;
  const { httpStatus, googleError } = answer;
  if (httpStatus === 200) {
    return check('vertex-model', `Claude (${model}) answers in ${location}`, 'ok');
  }
  if (httpStatus === 404 || (httpStatus === 403 && MODEL_NOT_ENABLED.test(googleError))) {
    return check(
      'vertex-model',
      `Claude ${model} is not enabled for your Google Cloud project; enable it before the first run`,
      'warn',
      `https://console.cloud.google.com/vertex-ai/publishers/anthropic/model-garden/${model}?project=${project}`,
    );
  }
  if (httpStatus === 403) return forbiddenCheck(model, googleError);
  if (httpStatus === 429) {
    return check(
      'vertex-model',
      `The quota for Claude in ${location} is exhausted`,
      'warn',
      `https://console.cloud.google.com/iam-admin/quotas?project=${project}` +
        ` (filter by base_model anthropic-${model.replace(/-\d.*$/u, '')})`,
    );
  }
  return unknown;
}
