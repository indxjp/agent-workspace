import { openapiTool, secret } from '@indx-workspace/sdk/define';

/**
 * The task tracker's write API. `aw push` reads `apis/tracker.openapi.json` and registers the one
 * operation `allow` names, `createTask` (`POST /tasks`); the platform's tool gateway calls the
 * tracker with `TRACKER_TOKEN`, which never enters the run. `identity` opts the tool in to the
 * signed caller assertion, so the tracker records who ran the meeting and assigns only inside the
 * departments that person covers. `createTask` is a write, so it is implicitly `requireApproval`: the
 * run pauses and the tracker creates the task only for the call a person approved, with the title,
 * assignee, due date and meeting they approved. The roster, scope, date and duplicate checks are the
 * tracker's own rules and stay in the tracker.
 */
export const tracker = openapiTool({
  name: 'tracker',
  spec: 'apis/tracker.openapi.json',
  auth: secret('TRACKER_TOKEN'),
  identity: secret('TRACKER_IDENTITY_SECRET'),
  allow: ['operationId:createTask'],
});
