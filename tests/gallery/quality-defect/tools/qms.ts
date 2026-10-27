import { openapiTool, secret } from '@indx-workspace/sdk/define';

/**
 * The QMS (quality management system). `aw push` reads `apis/qms.openapi.json` and registers one tool
 * per admitted operation (named by its `operationId`: `searchDefects`, `getDefect`, `causeStats`,
 * `createCase`); the platform's tool gateway calls the QMS with `QMS_TOKEN`, which never enters the
 * run. `identity` opts the tool in to the signed caller assertion: each call also carries who entered
 * the defect (`x-aw-identity`, signed with `QMS_IDENTITY_SECRET`), and the QMS verifies it and shows
 * that person only the 工程 whose past cases they may see. A glob `*` is exactly one path segment, so
 * `GET /defects/*` admits both `/defects/stats` and `/defects/{qNo}`. `createCase` (`POST /defects`)
 * is the one write, named by its operation id rather than a glob: it is implicitly `requireApproval`,
 * so the run pauses and the gateway registers the case only for the call the DR approved.
 */
export const qms = openapiTool({
  name: 'qms',
  spec: 'apis/qms.openapi.json',
  auth: secret('QMS_TOKEN'),
  identity: secret('QMS_IDENTITY_SECRET'),
  allow: ['GET /defects', 'GET /defects/*', 'operationId:createCase'],
});
