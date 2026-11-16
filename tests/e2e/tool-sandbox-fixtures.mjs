import { FAKE_PROVIDER_HOST } from '../generated-project/project.mjs';

/** `TOOL_SANDBOX_CONNECTOR_URL` (`@indx-workspace/contracts/tool-connectors`). */
export const TOOL_HOST_URL = 'https://tool-sandbox.invalid/mcp';

export const TOOL_NAME = 'getOrderByOrderNumber';

/** The secret the tool declares; its value is set through the API. */
export const DECLARED_SECRET = 'E2E_DECLARED';

/**
 * The host the tool declares, probed over plain HTTP so the proxy's own refusal is readable. The
 * proxy resolves it on its own outbound network, where it is the real host: the fake behind that
 * name lives on the stack's private network, which the proxy refuses to dial by design.
 */
export const ALLOWED_HOST = FAKE_PROVIDER_HOST;

export const AGENT = `import { defineAgent } from '@indx-workspace/sdk/define';
import getOrder from '../tools/get-order.ts';

export default defineAgent({
  name: 'assistant',
  instructions: 'Look up the order the person names with the tool.',
  model: 'anthropic default',
  tools: [getOrder],
});
`;

/** @param {string} network the declaration's `allowedDomains` line, or '' for a tool with no network */
const declarationOf = (
  network,
) => `import { defineTool, secret, z } from '@indx-workspace/sdk/define';

export default defineTool({
  name: '${TOOL_NAME}',
  description: 'Look up an order by its number',
  input: z.object({ orderNumber: z.string() }),
  run: './tools/get-order.run.ts',
  secrets: [secret('${DECLARED_SECRET}')],${network}
});
`;

export const DECLARATION = declarationOf(`\n  allowedDomains: ['${ALLOWED_HOST}'],`);

/**
 * The same tool with no network (ADR-0118 TS5), for a tool sandbox that cannot enforce a domain
 * allow-list: E2B runs a tool sandbox with network `none` or `open` only (ADR-0132).
 */
export const OFFLINE_DECLARATION = declarationOf('');

/** The offline tool's run file: the data and the declared secret, no egress probes. */
export const OFFLINE_RUN_FILE = `import type { ToolRun } from '@indx-workspace/sdk/define';
import type getOrder from './get-order.ts';

const run: ToolRun<typeof getOrder> = async ({ orderNumber }) => {
  const facts = [
    \`declared=\${process.env['${DECLARED_SECRET}'] ?? 'absent'}\`,
    \`database_url=\${process.env['DATABASE_URL'] === undefined ? 'absent' : 'present'}\`,
  ];
  return { orderNumber, note: \`order-data-\${orderNumber} \${facts.join(' ')}\` };
};
export default run;
`;

// Each probe answers reached:<status>, denied:<the proxy's reason> or error:<code>. It uses node:http,
// which sends a plain-HTTP request to HTTP_PROXY in absolute form (NODE_USE_ENV_PROXY), so the
// proxy's own 403 body is readable; fetch tunnels every request with CONNECT and turns a refused
// tunnel into a bare error (the R-14 research note, finding 5).
export const RUN_FILE = `import { request } from 'node:http';

import type { ToolRun } from '@indx-workspace/sdk/define';
import type getOrder from './get-order.ts';

function probe(url: string): Promise<string> {
  return new Promise((resolve) => {
    const outgoing = request(url, { timeout: 10_000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => {
        if (!body.includes('egress_denied')) resolve(\`reached:\${String(response.statusCode)}\`);
        else resolve(\`denied:\${String((JSON.parse(body) as { reason?: unknown }).reason)}\`);
      });
    });
    outgoing.on('timeout', () => outgoing.destroy(new Error('timeout')));
    outgoing.on('error', (error: Error & { code?: unknown }) => {
      resolve(\`error:\${String(error.code ?? error.message)}\`);
    });
    outgoing.end();
  });
}

const run: ToolRun<typeof getOrder> = async ({ orderNumber }) => {
  const [allowed, refused] = await Promise.all([
    probe('http://${ALLOWED_HOST}/'),
    probe('http://example.com/'),
  ]);
  const facts = [
    \`declared=\${process.env['${DECLARED_SECRET}'] ?? 'absent'}\`,
    \`database_url=\${process.env['DATABASE_URL'] === undefined ? 'absent' : 'present'}\`,
    \`allowed=\${allowed}\`,
    \`refused=\${refused}\`,
  ];
  return { orderNumber, note: \`order-data-\${orderNumber} \${facts.join(' ')}\` };
};
export default run;
`;
