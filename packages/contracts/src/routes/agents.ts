import type { ApiRoute } from './definition.js';
import { created, json, NO_CONTENT, ok, UNDESCRIBED } from './definition.js';
export const agentsRoutes: readonly ApiRoute[] = [
  // §5.9 — agents
  {
    method: 'GET',
    path: '/api/agents',
    operationId: 'agents.list',
    tag: 'agents',
    feature: 'core',
    summary: 'List agents',
    success: ok(json('AgentListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/agents',
    operationId: 'agents.create',
    tag: 'agents',
    feature: 'core',
    summary:
      'Create an agent, optionally with its resource assignments, or from a first version (dryRun checks it)',
    request: UNDESCRIBED,
    success: [
      ...created(
        json(
          'AgentResourceSchema',
          'CreateAgentWithAssignmentsResponseSchema',
          'CreateAgentFromVersionResponseSchema',
        ),
      ),
      ...ok(json('AgentVersionCheckResponseSchema')),
    ],
  },

  {
    method: 'GET',
    path: '/api/agents/:id',
    operationId: 'agents.get',
    tag: 'agents',
    feature: 'core',
    summary: 'Read one agent',
    success: ok(json('AgentResourceSchema')),
  },

  {
    method: 'PATCH',
    path: '/api/agents/:id',
    operationId: 'agents.update',
    tag: 'agents',
    feature: 'core',
    summary: 'Update an agent',
    request: UNDESCRIBED,
    success: ok(json('AgentResourceSchema')),
  },

  {
    method: 'DELETE',
    path: '/api/agents/:id',
    operationId: 'agents.remove',
    tag: 'agents',
    feature: 'core',
    summary: 'Delete an agent',
    success: NO_CONTENT,
  },

  {
    method: 'GET',
    path: '/api/agents/:id/resources',
    operationId: 'agents.getResourceAssignments',
    tag: 'agents',
    feature: 'core',
    summary: "Read an agent's resource assignments",
    success: ok(json('AgentResourceAssignmentsResponseSchema')),
  },

  {
    method: 'PUT',
    path: '/api/agents/:id/resources',
    operationId: 'agents.replaceResourceAssignments',
    tag: 'agents',
    feature: 'core',
    summary: "Replace an agent's resource assignments",
    request: json('AgentResourceAssignmentsSchema'),
    success: ok(json('AgentResourceAssignmentsResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/agents/:id/grants',
    operationId: 'agents.getGrants',
    tag: 'agents',
    feature: 'core',
    summary: "Read an agent's grants",
    success: ok(json('AgentGrantsSchema')),
  },

  {
    method: 'PUT',
    path: '/api/agents/:id/grants',
    operationId: 'agents.replaceGrants',
    tag: 'agents',
    feature: 'core',
    summary: "Replace an agent's grants",
    request: json('AgentGrantsSchema'),
    success: ok(json('AgentGrantsSchema')),
  },

  {
    method: 'GET',
    path: '/api/agents/:id/policy',
    operationId: 'agents.getPolicy',
    tag: 'agents',
    feature: 'core',
    summary: "Read an agent's policy",
    success: ok(json('AgentPolicyResponseSchema')),
  },

  {
    method: 'PUT',
    path: '/api/agents/:id/policy',
    operationId: 'agents.replacePolicy',
    tag: 'agents',
    feature: 'core',
    summary: "Replace an agent's policy",
    request: json('AgentPolicySchema'),
    success: ok(json('AgentPolicyResponseSchema')),
  },

  {
    method: 'GET',
    path: '/api/agents/:id/versions',
    operationId: 'agents.listVersions',
    tag: 'agents',
    feature: 'core',
    summary: "List an agent's versions and pointers",
    success: ok(json('AgentVersionListResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/agents/:id/versions',
    operationId: 'agents.createVersion',
    tag: 'agents',
    feature: 'core',
    summary: 'Save a version of an agent, or check one with dryRun',
    request: json('CreateAgentVersionRequestSchema'),
    success: [
      ...created(json('AgentVersionResourceSchema')),
      ...ok(json('AgentVersionCheckResponseSchema')),
    ],
  },

  {
    method: 'PUT',
    path: '/api/agents/:id/pointers',
    operationId: 'agents.setPointer',
    tag: 'agents',
    feature: 'core',
    summary: 'Point an environment at a saved version',
    request: json('SetAgentPointerRequestSchema'),
    success: ok(json('SetAgentPointerResponseSchema')),
  },

  /** Issue #615; production moves pass the promotion gate (issue #619). */
  {
    method: 'POST',
    path: '/api/agents/:id/promote',
    operationId: 'agents.promote',
    tag: 'agents',
    feature: 'core',
    summary: "Point production at local's version, or check the move with dryRun",
    request: json('PromoteAgentRequestSchema'),
    success: ok(json('AgentPointerMoveResponseSchema')),
  },

  /** Issue #615. */
  {
    method: 'POST',
    path: '/api/agents/:id/rollback',
    operationId: 'agents.rollback',
    tag: 'agents',
    feature: 'core',
    summary: 'Point an environment back at its previous version, or check it with dryRun',
    request: json('RollbackAgentRequestSchema'),
    success: ok(json('AgentPointerMoveResponseSchema')),
  },

  {
    method: 'POST',
    path: '/api/agents/:id/restore',
    operationId: 'agents.restore',
    tag: 'agents',
    feature: 'core',
    summary: 'Restore an archived agent',
    success: ok(json('AgentResourceSchema')),
  },

  /**
   * Issue #618. Synchronous: the server runs the cases one after another as ordinary runs, then
   * stores and answers the evaluation. At most 20 cases, and the server stops waiting after 225 s
   * (a case still running then fails with `deadline_exceeded`), so the answer arrives inside the
   * host's HTTP timeout: 240 s on Azure Container Apps, 300 s on Cloud Run; `aw dev` has none.
   * A client's own request timeout must allow for that.
   */
  {
    method: 'POST',
    path: '/api/agents/:id/evaluations',
    operationId: 'agents.evaluate',
    tag: 'agents',
    feature: 'evaluations',
    summary: "Run a version's evaluation cases and store the score",
    request: json('CreateEvaluationRequestSchema'),
    success: created(json('EvaluationResourceSchema')),
  },

  /**
   * Issue #799. Start an evaluation run of up to 200 cases: it is stored as `running` with no case
   * run yet. The client drives it: it calls `agents.evaluationRuns.advance` until the run is
   * `completed`.
   */
  {
    method: 'POST',
    path: '/api/agents/:id/evaluation-runs',
    operationId: 'agents.evaluationRuns.create',
    tag: 'agents',
    feature: 'evaluations',
    summary: "Start an asynchronous run of a version's evaluation cases",
    request: json('CreateEvaluationRunRequestSchema'),
    success: [{ status: 202, body: json('EvaluationRunResourceSchema') }],
  },

  /**
   * Issue #799. One evaluation run by id, at any status: the baseline that `aw eval --baseline <id>`
   * compares against once it is `completed`. Query: `evaluation`, the run's id, required; an id
   * that is not a UUID, is unknown or belongs to another agent answers `404 evaluation_not_found`.
   */
  {
    method: 'GET',
    path: '/api/agents/:id/evaluation-runs',
    operationId: 'agents.evaluationRuns.get',
    tag: 'agents',
    feature: 'evaluations',
    summary: 'Read an evaluation run and its results so far',
    success: ok(json('EvaluationRunResourceSchema')),
  },

  /**
   * Issue #799. Run the next cases of an evaluation run as ordinary runs and store each result as
   * it finishes. A call stops starting cases after about 120 s, so it answers inside the host's
   * HTTP timeout whatever the run's size; the answer is the run's progress, and the client calls
   * again until its `status` is `completed`. One call advances a run at a time (`409
   * evaluation_run_busy`); a completed run is answered unchanged. A dropped client leaves the run
   * `running`, and the promotion gate never reads a run that has not completed.
   */
  {
    method: 'POST',
    path: '/api/agents/:id/evaluation-advance',
    operationId: 'agents.evaluationRuns.advance',
    tag: 'agents',
    feature: 'evaluations',
    summary: 'Run the next cases of an evaluation run',
    request: json('AdvanceEvaluationRunRequestSchema'),
    success: ok(json('EvaluationRunResourceSchema')),
  },

  /**
   * Issue #620. The newest 50 ratings of the agent's runs, each with the run's prompt and answer,
   * so a thumbs-down can become an evaluation case. Optional query: `rating`, `since` (ISO 8601)
   * and `runId`. A caller who reads only their own runs sees only the ratings of those.
   */
  {
    method: 'GET',
    path: '/api/agents/:id/feedback',
    operationId: 'agents.listFeedback',
    tag: 'agents',
    feature: 'runs',
    summary: "List the ratings of an agent's runs",
    success: ok(json('RunFeedbackListResponseSchema')),
  },
];
