import { openapiTool, secret } from '@indx-workspace/sdk/define';

/**
 * The ERP, read-only. `aw push` reads `apis/erp.openapi.json` and registers one tool per admitted
 * operation (named by its `operationId`: `searchParts`, `getOrder`, `getRate`); the platform's
 * tool gateway calls the ERP with `ERP_TOKEN`, which never enters the run. A glob `*` is exactly
 * one path segment, so `GET /parts/*` admits `/parts/search` and `GET /orders/*` admits
 * `/orders/{orderNo}`. The document's `POST /quotes` is not admitted, and cannot be: a write
 * rule is refused when the tool is defined.
 */
export const erp = openapiTool({
  name: 'erp',
  spec: 'apis/erp.openapi.json',
  auth: secret('ERP_TOKEN'),
  allow: ['GET /parts/*', 'GET /orders/*', 'GET /rates/*'],
});
