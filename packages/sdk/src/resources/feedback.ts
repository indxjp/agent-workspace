import {
  RunFeedbackListResponseSchema,
  type RunFeedbackItem,
  type RunFeedbackListQuery,
} from '@indx-workspace/contracts/feedback';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

/** `/api/agents/:id/feedback` — issue #620: the ratings of an agent's runs. */
export class FeedbackClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /**
   * The newest ratings of the agent's runs, at most 50, each with its run's prompt (`input`, `null`
   * for a run recorded before prompts were stored) and final answer (`GET /api/agents/:id/feedback`).
   * A caller who reads only their own runs gets only the ratings of those.
   *
   * Throws {@link ApiProblemError} with a code from `RUN_FEEDBACK_LIST_PROBLEM_CODES`:
   * `400 invalid_agent_id`, `400 invalid_query`, `404 agent_not_found`,
   * `503 run_api_not_configured`.
   */
  public async list(
    agentId: string,
    query: RunFeedbackListQuery = {},
    options: RequestOptions = {},
  ): Promise<readonly RunFeedbackItem[]> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === 'string') params.set(key, value);
    }
    const response = await this.#http.json({
      operation: 'agents.listFeedback',
      method: 'GET',
      path: `/api/agents/${segment(agentId)}/feedback`,
      query: params,
      expect: [200],
      schema: RunFeedbackListResponseSchema,
      signal: options.signal,
    });
    return response.items;
  }
}
