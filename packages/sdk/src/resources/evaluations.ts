import {
  EvaluationResourceSchema,
  EvaluationRunResourceSchema,
  type CreateEvaluationRequest,
  type CreateEvaluationRunRequest,
  type EvaluationResource,
  type EvaluationRunResource,
} from '@indx-workspace/contracts/evaluations';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

/**
 * `/api/agents/:id/evaluations` — issue #618. An evaluation runs every case of an
 * `evals/<agent>.yaml` file against one version of the agent, scores it on the server and stores
 * the score.
 */
export class EvaluationsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /**
   * Run `request.cases` against version `request.version`, whatever `local` points at, and store
   * the score (`POST /api/agents/:id/evaluations`, `201`). Synchronous: the server answers once
   * every case has run, after at most about 225 s, so a configured `timeoutMs` must allow for that
   * and a host that cuts long requests (a Worker relay, say) can drop it. All the cases share that
   * budget, so a slow agent's last cases fail `deadline_exceeded`: prefer {@link createRun} plus
   * `advanceRun`, which give each case its own deadline and resume after a dropped step, though one
   * step can still last about 220 s. A failed case is a result, not an error: read `passed`,
   * `total` and each result's `failures`.
   *
   * Throws {@link ApiProblemError} with a code from `EVALUATION_PROBLEM_CODES`:
   *
   * - `400 invalid_body` — each `details` entry is one parse issue; `400 invalid_agent_id`;
   * - `404 agent_not_found`; `404 agent_version_not_found` — `details` is `[version:<n>]`;
   * - the first case's refused start (`RUN_START_PROBLEM_CODES`, `422 engine_not_installed`,
   *   `409 session_not_usable`); nothing is stored then;
   * - `503 agent_policy_not_configured`, `503 run_api_not_configured`.
   */
  public async create(
    agentId: string,
    request: CreateEvaluationRequest,
    options: RequestOptions = {},
  ): Promise<EvaluationResource> {
    return this.#http.json({
      operation: 'agents.evaluate',
      method: 'POST',
      path: `/api/agents/${segment(agentId)}/evaluations`,
      body: request,
      expect: [201],
      schema: EvaluationResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Store an evaluation run of up to 200 cases against version `request.version`
   * (`POST /api/agents/:id/evaluation-runs`, `202`; issue #799). Nothing runs yet: call
   * {@link advanceRun} until the returned run's `status` is `completed`. Refusals are the
   * `400 invalid_body`, `404 agent_not_found`, `404 agent_version_not_found` and
   * `503 run_api_not_configured` of {@link create}.
   */
  public async createRun(
    agentId: string,
    request: CreateEvaluationRunRequest,
    options: RequestOptions = {},
  ): Promise<EvaluationRunResource> {
    return this.#http.json({
      operation: 'agents.evaluationRuns.create',
      method: 'POST',
      path: `/api/agents/${segment(agentId)}/evaluation-runs`,
      body: request,
      expect: [202],
      schema: EvaluationRunResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Run the next cases of run `evaluationId` (`POST /api/agents/:id/evaluation-advance`, `200`)
   * and read how far it is. A call answers after at most about 225 s, so a configured `timeoutMs`
   * must allow for that; it stops starting cases after about 120 s and always runs at least one.
   * Call it until `status` is `completed`; a completed run is answered unchanged.
   *
   * Throws `404 evaluation_not_found`, `409 evaluation_run_busy` (another call is advancing the
   * run: retry in a moment), `400 invalid_body` or `503 run_api_not_configured`.
   */
  public async advanceRun(
    agentId: string,
    evaluationId: string,
    options: RequestOptions = {},
  ): Promise<EvaluationRunResource> {
    return this.#http.json({
      operation: 'agents.evaluationRuns.advance',
      method: 'POST',
      path: `/api/agents/${segment(agentId)}/evaluation-advance`,
      body: { evaluationId },
      expect: [200],
      schema: EvaluationRunResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Read run `evaluationId` at any status (`GET /api/agents/:id/evaluation-runs?evaluation=<id>`).
   * Throws `404 evaluation_not_found` for an id that is not a run of this agent.
   */
  public async getRun(
    agentId: string,
    evaluationId: string,
    options: RequestOptions = {},
  ): Promise<EvaluationRunResource> {
    return this.#http.json({
      operation: 'agents.evaluationRuns.get',
      method: 'GET',
      path: `/api/agents/${segment(agentId)}/evaluation-runs`,
      query: new URLSearchParams({ evaluation: evaluationId }),
      expect: [200],
      schema: EvaluationRunResourceSchema,
      signal: options.signal,
    });
  }
}
