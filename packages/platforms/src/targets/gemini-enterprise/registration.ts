import type { A2aAgentCard } from '@indx-workspace/contracts/a2a';
import { z } from 'zod';

import type { GeminiEnterpriseOptions } from './options.js';

/** The create-agent body of `POST …/assistants/default_assistant/agents` (Gemini Enterprise, v1alpha). */
export const GeminiAgentRegistrationSchema = z.strictObject({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().min(1),
  a2aAgentDefinition: z.strictObject({ jsonAgentCard: z.string().min(1) }),
  authorizationConfig: z.strictObject({ agentAuthorization: z.string().min(1) }).optional(),
});
export type GeminiAgentRegistration = z.output<typeof GeminiAgentRegistrationSchema>;

export interface GeminiRegistrationRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly body: GeminiAgentRegistration;
}

/** `global` is `global-discoveryengine.googleapis.com` too (register page, ENDPOINT_LOCATION). */
export function discoveryEngineHost(location: GeminiEnterpriseOptions['location']): string {
  return `${location}-discoveryengine.googleapis.com`;
}

/** The exact request U3b's executor sends; pure, keys in the order the golden shows. */
export function buildRegistrationRequest(
  agentName: string,
  card: A2aAgentCard,
  options: GeminiEnterpriseOptions,
): GeminiRegistrationRequest {
  const { projectId, location, engineId, authorizationId } = options;
  return {
    method: 'POST',
    url:
      `https://${discoveryEngineHost(location)}/v1alpha/projects/${projectId}/locations/${location}` +
      `/collections/default_collection/engines/${engineId}/assistants/default_assistant/agents`,
    body: {
      name: agentName,
      displayName: card.name,
      description: card.description,
      a2aAgentDefinition: { jsonAgentCard: JSON.stringify(card) },
      ...(authorizationId === undefined
        ? {}
        : {
            authorizationConfig: {
              agentAuthorization: `projects/${projectId}/locations/${location}/authorizations/${authorizationId}`,
            },
          }),
    },
  };
}
