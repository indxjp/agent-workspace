import type { IncomingMessage, ServerResponse } from 'node:http';

import type { FakeRequestRecord } from '../generated-project/fake-anthropic.mjs';

export const ORDER_OPERATION_ID: 'getOrderByOrderNumber';
export function orderNote(orderNumber: string): string;

export type ToolRequestRecord = {
  readonly nonce: string | null;
  readonly toolNames: readonly string[];
  readonly toolUse: { readonly name: string; readonly input: Record<string, string> } | null;
  readonly toolResult: string | null;
};

export function createAnthropicToolsHandler(
  requests: FakeRequestRecord[],
  toolRequests: ToolRequestRecord[],
  bodies?: string[],
): (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export type OrdersCall = {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | null;
};

export function createOrdersApi(calls: OrdersCall[]): {
  handler: (request: IncomingMessage, response: ServerResponse) => void;
  document: (origin: string) => string;
};
