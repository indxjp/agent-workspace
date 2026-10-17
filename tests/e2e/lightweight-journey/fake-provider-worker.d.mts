import type { IncomingMessage, ServerResponse } from 'node:http';

type Handler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export function answer(handler: Handler, request: Request): Promise<Response>;
export function fakeProviderFetch(
  handler: Handler,
  key: string | undefined,
): (request: Request) => Promise<Response>;

declare const worker: {
  fetch: (request: Request, env: { FAKE_PROVIDER_KEY?: string }) => Promise<Response>;
};
export default worker;
