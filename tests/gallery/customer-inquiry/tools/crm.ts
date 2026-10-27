import { openapiTool, secret } from '@indx-workspace/sdk/define';

/**
 * The CRM's interaction history, read-only. `aw push` reads `apis/crm.openapi.json` and registers
 * one tool per admitted operation (`searchInteractions`, `getInteraction`); the platform's tool
 * gateway calls the CRM with `CRM_TOKEN`, which never enters the run. `GET /interactions/*` admits
 * `/interactions/search` and `/interactions/{id}`; the document's `PUT /customers/me/address` is
 * not admitted: no rule here names it, and a write would run only for an approved call anyway.
 *
 * The tool takes no customer id: whose history it reads is the caller's signed identity. `identity`
 * opts the tool in to the signed caller assertion (ADR-0142): each call also carries who started
 * the run (`x-aw-identity`, signed with `CRM_IDENTITY_SECRET`), and the CRM verifies it and answers
 * that customer's records only. The CRM masks personal data itself.
 */
export const crm = openapiTool({
  name: 'crm',
  spec: 'apis/crm.openapi.json',
  auth: secret('CRM_TOKEN'),
  identity: secret('CRM_IDENTITY_SECRET'),
  allow: ['GET /interactions/*'],
});
