import { randomUUID } from 'node:crypto';
import { serveBuilderMcp } from '../mcp';
import { type Door, type ToolAnswer } from './harness-contract';

export function spyPorts<P extends Record<string, object>>(real: P, portCalls: string[]): P {
  const wrapped: Record<string, object> = {};
  for (const [port, impl] of Object.entries(real)) {
    if (typeof impl === 'function') {
      wrapped[port] = impl;
      continue;
    }
    const methods: Record<string, unknown> = {};
    for (const [method, fn] of Object.entries(impl)) {
      methods[method] =
        typeof fn === 'function'
          ? (...args: unknown[]) => {
              portCalls.push(`${port}.${method}`);
              return (fn as (...a: unknown[]) => unknown).apply(impl, args);
            }
          : fn;
    }
    wrapped[port] = methods;
  }
  return wrapped as P;
}

export function createHarnessCall(
  deps: Parameters<typeof serveBuilderMcp>[1],
  responses: string[],
  responseHeaders: string[],
): Door['call'] {
  async function call(
    token: string,
    name: string,
    args: unknown,
    headers: Readonly<Record<string, string>> = {},
    callId: string = randomUUID(),
  ): Promise<ToolAnswer> {
    const response = await serveBuilderMcp(
      new Request('http://web.test/api/builder/mcp', {
        method: 'POST',
        headers: {
          ...headers,
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            _meta: { 'claudecode/toolUseId': callId },
          },
        }),
      }),
      deps,
    );
    const text = await response.text();
    responses.push(text);
    responseHeaders.push(JSON.stringify([...response.headers]));
    const body = JSON.parse(text) as {
      result?: { isError?: boolean; content: { type: string; text: string }[] };
      error?: Record<string, unknown>;
    };
    // The door refuses a token before any JSON-RPC: the answer is the HTTP problem body.
    if (body.result === undefined) {
      return { isError: true, status: response.status, result: { ok: false, ...body.error } };
    }
    const { result } = body;
    const [content] = result.content;
    if (content === undefined) throw new Error('tools/call answered no content');
    return {
      isError: result.isError === true,
      status: response.status,
      result: JSON.parse(content.text) as Record<string, unknown>,
    };
  }
  return call;
}
