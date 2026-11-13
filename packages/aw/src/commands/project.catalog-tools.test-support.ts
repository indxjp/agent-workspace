import { expect, it } from 'vitest';
import { EXIT_CODE } from '../output.js';
import { json, type Route } from '../testing.js';
import {
  aw,
  emptyServer,
  problem,
  project,
  requests,
  server,
} from './project.fixture.test-support.js';

export function describeProjectCatalogTools(): void {
  const CONFIGURED = {
    AGENT_WORKSPACE_URL: 'https://aw.example.com',
    AGENT_WORKSPACE_API_KEY: 'ak_live_test',
  };

  const EXTERNAL_REF = '$ref "./other.yaml#/X": only references within the document are supported';

  const files = {
    'agents/assistant.ts': `import { defineAgent } from '@indx-workspace/sdk/define';
import { orders } from '../tools/orders';
export default defineAgent({ name: 'assistant', instructions: 'Help people.', tools: [orders] });
`,
    'tools/orders.ts': `import { openapiTool, secret } from '@indx-workspace/sdk/define';
export const orders = openapiTool({
  name: 'orders',
  spec: 'apis/orders.openapi.json',
  allow: ['GET /orders/*'],
  auth: secret('ORDERS_TOKEN'),
});
`,
    'apis/orders.openapi.json':
      '{"openapi":"3.1.0","info":{"title":"Orders","version":"1"},"paths":{"/orders/{id}":{"get":{"responses":{"200":{"$ref":"./other.yaml#/X"}}}}}}',
  };

  function withConnectors(): Route {
    const agents = server(emptyServer());
    return (request) => {
      if (request.url.pathname !== '/api/connectors') return agents(request);
      if (request.method === 'GET') return json(200, { connectors: [] });
      return problem(422, 'connector_spec_invalid', [EXTERNAL_REF]);
    };
  }

  it("prints a refused document against the tool's file and exits 1, never sending the token", async () => {
    const root = await project(files);
    const run = await aw(root, ['check'], withConnectors(), {
      env: { ...CONFIGURED, ORDERS_TOKEN: 'sentinel-orders-token' },
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain(`tools/orders.ts: 422 connector_spec_invalid [${EXTERNAL_REF}]\n`);
    const dryRun = run.calls.find(
      (call) => call.method === 'POST' && call.url.pathname === '/api/connectors',
    );
    expect(dryRun?.json).toMatchObject({ dryRun: true, credential: 'aw-check-placeholder' });
    expect(JSON.stringify(run.calls.map((call) => call.json))).not.toContain(
      'sentinel-orders-token',
    );
  });

  it('aw push applies the tool first, and a refused one stops it before any agent is saved (issue #789)', async () => {
    const root = await project(files);
    const run = await aw(root, ['push', '--yes'], withConnectors(), {
      env: { ...CONFIGURED, ORDERS_TOKEN: 'sentinel-orders-token' },
    });
    expect(run.code).toBe(EXIT_CODE.problem);
    expect(run.stdout).toContain(`tools/orders.ts: 422 connector_spec_invalid [${EXTERNAL_REF}]\n`);
    expect(requests(run).filter((call) => call.includes('/api/connectors'))).not.toEqual([]);
    const saved = run.calls.filter(
      (call) =>
        call.method === 'POST' &&
        call.url.pathname.startsWith('/api/agents') &&
        (call.json as { dryRun?: boolean } | undefined)?.dryRun !== true,
    );
    expect(saved).toEqual([]);
  });
}
