export type AzureOpenAIOperation = 'responses' | 'responses/input_tokens' | 'chat/completions';

const LOCAL_FIXTURE_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

export function normalizeEndpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !LOCAL_FIXTURE_HOSTS.includes(url.hostname)) {
    throw new Error('Azure OpenAI endpoint must use https except for localhost fixture servers.');
  }
  return url.toString().replace(/\/$/u, '');
}

export function requiredDeployment(value: string): string {
  const deployment = value.trim();
  if (deployment.length === 0) throw new Error('Azure OpenAI deployment is required.');
  return deployment;
}

/** R-05's two URL families, kept explicit so a deployment is never confused with a model name. */
export function buildAzureOpenAIUrl(
  endpoint: string,
  deployment: string,
  apiVersion: string | undefined,
  operation: AzureOpenAIOperation,
): string {
  const root = normalizeEndpoint(endpoint);
  const deploymentName = encodeURIComponent(requiredDeployment(deployment));
  const version = apiVersion?.trim();
  if (version === undefined || version === '' || version === 'v1') {
    return `${root}/openai/v1/${operation}`;
  }
  if (version === 'preview') {
    return `${root}/openai/v1/${operation}?api-version=preview`;
  }
  const query = `api-version=${encodeURIComponent(version)}`;
  if (operation === 'chat/completions') {
    return `${root}/openai/deployments/${deploymentName}/chat/completions?${query}`;
  }
  // R-05's executed SDK probe establishes that Responses is not deployment-scoped on the dated
  // surface; the deployment still travels as the request body's `model` value.
  // `responses/input_tokens` keeps its suffix: dropping it would turn a count into a billed generation.
  return `${root}/openai/${operation}?${query}`;
}
