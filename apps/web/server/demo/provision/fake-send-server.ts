/**
 * The stand-in a demo agent's tool that would send or write outside is replaced by. It is an MCP
 * server on standard input and output that has no network, file or process code at all: every tool
 * call answers `DEMO_SEND_RESULT` and does nothing else but echo the call back in
 * `structuredContent` (`demoOnly`, `delivered: false`, the tool and its arguments), which is how
 * the test, and the run transcript, show what the agent tried to send (internal spec,
 * "Email-link sign-in", fake sends). The copy of the demo agent is given a connector that runs this source, in place of
 * the connector that would reach the outside, under the same name; the copy's tool rules are
 * pointed at the stand-in's id (`policy-remap.ts`), so the template's approval and deny rules still
 * apply.
 *
 * The source is one plain string with no `require` and no `import`, so what it can do is what it
 * says; `fake-send-server.test.ts` runs it and reads it for anything that could reach out.
 */
import { DEMO_SEND_RESULT } from '@indx-workspace/contracts/demo';

/** The tool a stand-in offers when the connector it replaces names no operation of its own. */
export const FAKE_SEND_DEFAULT_TOOL = 'send';

/** The protocol revision the stand-in answers `initialize` with. */
const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * The framing both stand-ins share (`records-server.ts` is the other): one JSON-RPC message per
 * line on standard input, one answer per line on standard output. A source that includes it
 * defines `handlers`, an object of method name to a function of the request's `params`.
 */
export const STAND_IN_FRAMING = `
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  let end = buffered.indexOf('\\n');
  while (end >= 0) {
    const line = buffered.slice(0, end).trim();
    buffered = buffered.slice(end + 1);
    end = buffered.indexOf('\\n');
    if (line === '') continue;
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request === null || typeof request !== 'object' || request.id === undefined) continue;
    const handler = Object.hasOwn(handlers, request.method) ? handlers[request.method] : undefined;
    if (handler === undefined) {
      send({ id: request.id, error: { code: -32601, message: 'method not found' } });
    } else {
      send({ id: request.id, result: handler(request.params) });
    }
  }
});
`;

/** The `initialize` answer of a stand-in named `name`, as source text for its `handlers`. */
export function initializeHandlerSource(name: string): string {
  return `initialize: () => ({
    protocolVersion: ${JSON.stringify(MCP_PROTOCOL_VERSION)},
    capabilities: { tools: {} },
    serverInfo: { name: ${JSON.stringify(name)}, version: '1' },
  }),
  ping: () => ({}),`;
}

const SERVER_SOURCE = `
const tools = process.argv.slice(1);
const answer = ${JSON.stringify(DEMO_SEND_RESULT.en)};
const handlers = {
  ${initializeHandlerSource('demo-stand-in')}
  'tools/list': () => ({
    tools: tools.map((name) => ({
      name,
      description: 'Demo only: this does nothing and sends nothing.',
      inputSchema: { type: 'object', additionalProperties: true },
    })),
  }),
  'tools/call': (params) => ({
    content: [{ type: 'text', text: answer }],
    // The call is echoed, so a test (and the run transcript) can see what the agent tried to do.
    structuredContent: { demoOnly: true, delivered: false, tool: params?.name ?? null, arguments: params?.arguments ?? null },
  }),
};
${STAND_IN_FRAMING}`;

/** The command and arguments of a stdio connector that runs the stand-in offering `toolNames`. */
export function fakeSendServerCommand(toolNames: readonly string[]): {
  readonly command: string;
  readonly args: readonly string[];
} {
  const names = toolNames.length > 0 ? toolNames : [FAKE_SEND_DEFAULT_TOOL];
  return { command: 'node', args: ['-e', SERVER_SOURCE, ...names] };
}
