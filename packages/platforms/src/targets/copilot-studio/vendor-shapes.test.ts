import { describe, expect, it } from 'vitest';

import { agentDocument, childAgentDocument, mcpActionDocument } from './vendor-shapes.js';

// These pin the optional-key rules; the goldens pin the rest, and `vendor-samples.test.ts` pins
// the key paths to Microsoft's samples.
describe('vendor shapes', () => {
  const base = {
    name: 'a',
    description: undefined,
    instructions: 'i',
    modelNameHint: undefined,
    webBrowsing: false,
    codeInterpreter: false,
    conversationStarters: undefined,
  };

  it('leaves an unset optional key out of the agent document', () => {
    expect(Object.keys(agentDocument(base))).toEqual([
      'mcs.metadata',
      'kind',
      'displayName',
      'instructions',
    ]);
  });

  it('emits only the capabilities that are on, the hint and the starters when given', () => {
    const document = agentDocument({
      ...base,
      modelNameHint: 'm',
      webBrowsing: true,
      conversationStarters: [{ title: 't', text: 'x' }],
    });
    expect(document['gptCapabilities']).toEqual({ webBrowsing: true });
    expect(document['aISettings']).toEqual({ model: { modelNameHint: 'm' } });
    expect(document['conversationStarters']).toEqual([{ title: 't', text: 'x' }]);
  });

  it('limits an MCP action to named tools only when asked', () => {
    const input = { name: 's', connectionReference: 'p_a.mcp.s', mode: 'Invoker' as const };
    const details = (document: Readonly<Record<string, unknown>>): unknown =>
      (document['action'] as { operationDetails: unknown }).operationDetails;
    expect(details(mcpActionDocument({ ...input, toolNames: undefined }))).not.toHaveProperty(
      'tools',
    );
    expect(details(mcpActionDocument({ ...input, toolNames: ['t'] }))).toHaveProperty('tools', {
      kind: 'UseSpecificTools',
      tools: ['t'],
    });
  });

  it('leaves the description out of a child agent without one', () => {
    const document = childAgentDocument({ name: 'c', description: undefined, instructions: 'i' });
    expect(document['beginDialog']).toEqual({ kind: 'OnToolSelected', id: 'main' });
  });
});
