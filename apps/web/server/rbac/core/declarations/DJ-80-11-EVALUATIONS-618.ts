import type { SubResourceDeclaration } from '../declared-sub-resources';

export const subResources: readonly SubResourceDeclaration[] = [
  {
    owner: 'DJ-80-11-EVALUATIONS-618',
    resource: 'agents',
    sub: 'evaluations',
    because:
      '§21 gives Builder and Admin agent-management access, and an evaluation scores a saved version of the agent definition and stores that score against it, so it is part of managing the agent and inherits the parent agent authorization exactly as DJ-S1-05-AGENT-VERSIONS-443 declared versions do.',
  },
  {
    owner: 'DJ-80-11-EVALUATIONS-618',
    resource: 'agents',
    sub: 'evaluation-runs',
    because:
      'An evaluation run is the same scoring of a saved version as an evaluation, only larger and advanced by the client in steps (issue #799), so it is part of managing the agent and inherits the parent agent authorization exactly as the evaluations sub-resource does.',
  },
  {
    owner: 'DJ-80-11-EVALUATIONS-618',
    resource: 'agents',
    sub: 'evaluation-advance',
    because:
      'Advancing an evaluation run (issue #799) runs the next cases of a stored run, so it is the same agent-management act as creating the run and inherits the parent agent authorization exactly as the evaluation-runs sub-resource does; its path is a sibling segment, not a nested one, because RBAC admits only /api/<resource>/:id/<sub>.',
  },
];
