import { openapiTool, secret } from '@indx-workspace/sdk/define';

/**
 * The workflow system. `aw push` reads `apis/workflow.openapi.json` and registers the one operation
 * `allow` names, `postComment` (`POST /requests/{requestId}/comments`); the platform's tool gateway
 * calls the workflow system with `WORKFLOW_TOKEN`, which never enters the run. The document also
 * declares `approveRequest` and `rejectRequest`, and the rules do not admit them: the agent has no
 * tool that can approve or reject a ringi. `postComment` is a write, so it is implicitly
 * `requireApproval`: the run pauses and the comment is posted only for the call a person approved.
 * `identity` opts the tool in to the signed caller assertion (`x-aw-identity`, signed with
 * `WORKFLOW_IDENTITY_SECRET`): the workflow system verifies who started the run and refuses a comment
 * on a ringi outside that person's departments exactly as it refuses one that does not exist.
 */
export const workflow = openapiTool({
  name: 'workflow',
  spec: 'apis/workflow.openapi.json',
  auth: secret('WORKFLOW_TOKEN'),
  identity: secret('WORKFLOW_IDENTITY_SECRET'),
  allow: ['operationId:postComment'],
});
