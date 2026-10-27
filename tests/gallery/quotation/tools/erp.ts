import { openapiTool, secret } from '@indx-workspace/sdk/define';

/**
 * The ERP. `aw push` reads `apis/erp.openapi.json` and registers one tool per admitted operation
 * (named by its `operationId`: `searchParts`, `getOrder`, `getRate`, `createQuote`); the platform's
 * tool gateway calls the ERP with `ERP_TOKEN`, which never enters the run. `identity` opts the tool
 * in to the signed caller assertion: each call also carries who started the run (`x-aw-identity`,
 * signed with `ERP_IDENTITY_SECRET`), and the ERP verifies it and shows that salesperson only their
 * own customers' orders. A glob `*` is exactly
 * one path segment, so `GET /parts/*` admits `/parts/search` and `GET /orders/*` admits
 * `/orders/{orderNo}`. `createQuote` (`POST /quotes`) is the one write, named by its operation id
 * rather than a glob: it is implicitly `requireApproval`, so the run pauses and the gateway books
 * the quote in the ERP only for the call a person approved.
 */
export const erp = openapiTool({
  name: 'erp',
  spec: 'apis/erp.openapi.json',
  auth: secret('ERP_TOKEN'),
  identity: secret('ERP_IDENTITY_SECRET'),
  allow: ['GET /parts/*', 'GET /orders/*', 'GET /rates/*', 'operationId:createQuote'],
});
