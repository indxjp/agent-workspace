import type { IncomingMessage, ServerResponse } from 'node:http';

export const FAKE_MODELS: readonly string[];
export const REJECTED_KEY_PREFIX: string;

export type FakeRequestRecord = {
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly model: string | null;
  readonly stream: boolean;
  readonly reply: string | null;
  readonly apiKey: string | null;
};

export type StreamEvent = { readonly type: string } & Readonly<Record<string, unknown>>;

export function fakeReplyText(body: unknown): string;
export function modelList(): {
  data: { type: 'model'; id: string; display_name: string; created_at: string }[];
  has_more: boolean;
  first_id: string | null;
  last_id: string | null;
};
export function messageResponse(id: string, model: string, text: string): Record<string, unknown>;
export function messageStreamEvents(id: string, model: string, text: string): StreamEvent[];
export function encodeSse(events: readonly StreamEvent[]): string;
export function createAnthropicHandler(
  requests: FakeRequestRecord[],
): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
