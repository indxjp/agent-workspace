/* global URL, Response */
/**
 * The journey's scripted Anthropic API as a Cloudflare Worker. A hosted deployment cannot alias
 * `api.anthropic.com` the way the Compose journey does, so setup is given this Worker's URL as its
 * provider base URL. It is `createAnthropicToolsHandler` (the Z1 journey's fake, unchanged) behind
 * a fetch-to-node adapter, and it answers only the run's fake key (`FAKE_PROVIDER_KEY`, a Worker
 * secret), so the public URL is not an open endpoint.
 *
 * ponytail: the handler's request records grow for the Worker isolate's life, which is one journey.
 */
import { Buffer } from 'node:buffer';
import { Readable } from 'node:stream';

import { createAnthropicToolsHandler } from '../../journey/fake-anthropic-tools.mjs';

/**
 * Runs a node-style `(request, response)` handler over a fetch `Request`. The fakes only call
 * `writeHead` then `end` with a whole body, so nothing streams.
 *
 * @param {(request: unknown, response: unknown) => Promise<void>} handler @param {Request} request
 * @returns {Promise<Response>}
 */
export async function answer(handler, request) {
  const url = new URL(request.url);
  const bodiless = request.method === 'GET' || request.method === 'HEAD';
  const incoming = Object.assign(
    Readable.from(bodiless ? [] : [Buffer.from(await request.arrayBuffer())]),
    {
      method: request.method,
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(request.headers),
    },
  );
  return new Promise((resolve, reject) => {
    let status = 200;
    /** @type {Record<string, string>} */
    let headers = {};
    const outgoing = {
      writeHead(/** @type {number} */ code, /** @type {Record<string, string>} */ head) {
        status = code;
        headers = head;
      },
      end(/** @type {string} */ body) {
        resolve(new Response(body, { status, headers }));
      },
    };
    handler(incoming, outgoing).catch(reject);
  });
}

/** The Worker's `fetch`, over a handler and the key it accepts. */
export function fakeProviderFetch(handler, key) {
  return async (/** @type {Request} */ request) => {
    if (key === undefined || request.headers.get('x-api-key') !== key) {
      return Response.json(
        { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        { status: 401 },
      );
    }
    return answer(handler, request);
  };
}

const handler = createAnthropicToolsHandler([], []);

export default {
  fetch: (/** @type {Request} */ request, /** @type {{ FAKE_PROVIDER_KEY?: string }} */ env) =>
    fakeProviderFetch(handler, env.FAKE_PROVIDER_KEY)(request),
};
