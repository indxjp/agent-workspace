/**
 * Recorded agent frames for the evaluation tests (issue #618): what the run of the issue's demo case
 * "order status uses the tool" stores, trimmed to the frames scoring reads.
 */
import type { AgentFrame } from '@indx-workspace/contracts/run-events';

const base = { engine: 'claude-agent-sdk', raw: null } as const;

export function assistantSays(text: string, messageId = 'msg_1'): AgentFrame {
  return {
    frame: 'agent.message',
    ...base,
    messageId,
    role: 'assistant',
    blocks: [
      { type: 'reasoning', text: 'Look the order up first.' },
      { type: 'text', text },
    ],
  };
}

export function toolCall(name: string): AgentFrame {
  return {
    frame: 'agent.tool.call',
    ...base,
    toolCallId: `call_${name}`,
    name,
    kind: 'mcp',
    input: { orderNumber: '1042' },
  };
}

export const ORDER_STATUS_FRAMES: readonly AgentFrame[] = [
  {
    frame: 'agent.message',
    ...base,
    messageId: null,
    role: 'user',
    blocks: [{ type: 'text', text: 'Where is order 1042?' }],
  },
  assistantSays('Let me check.', 'msg_0'),
  toolCall('orders_getOrder'),
  assistantSays('Order 1042 has '),
  assistantSays('Order 1042 has shipped.'),
];
