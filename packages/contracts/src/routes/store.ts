import type { ApiRoute } from './definition.js';
import { json, ok } from './definition.js';

/** The Agent Store's routes: its lead form, the facts its privacy notice states, and the demo allowance. */
export const storeRoutes: readonly ApiRoute[] = [
  {
    method: 'POST',
    path: '/api/store/leads',
    operationId: 'store.sendLead',
    tag: 'store',
    feature: 'core',
    summary:
      'Send the store enquiry form or ask to be told when a coming-soon entry launches; the same 202 for every address',
    request: json('StoreLeadRequestSchema'),
    success: [{ status: 202, body: json('StoreLeadReceivedResponseSchema') }],
    security: 'none',
  },
  {
    method: 'GET',
    path: '/api/store/privacy',
    operationId: 'store.privacy',
    tag: 'store',
    feature: 'core',
    summary: 'Read the lead retention period and demo workspace lifetime the privacy notice states',
    success: ok(json('StorePrivacyFactsSchema')),
    security: 'none',
  },
  {
    method: 'GET',
    path: '/api/store/demos',
    operationId: 'store.demos',
    tag: 'store',
    feature: 'core',
    summary: 'Read which live demos are under maintenance, for the store to show on their cards',
    success: ok(json('StoreDemoStatesSchema')),
    security: 'none',
  },
  {
    method: 'GET',
    path: '/api/demo/allowance',
    operationId: 'demo.allowance',
    tag: 'demo',
    feature: 'core',
    summary: "Read what the signed-in guest's demo workspace has left: runs and time",
    success: ok(json('DemoAllowanceSchema')),
  },
];
