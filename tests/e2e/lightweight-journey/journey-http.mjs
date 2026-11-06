/* global fetch, AbortSignal */
import { setTimeout as delay } from 'node:timers/promises';

/** @param {string} url @param {RequestInit & { token?: string }} [init] */
export async function call(url, { token, ...init } = {}) {
  const headers = {
    accept: 'application/json',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...init.headers,
  };
  const response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(120_000) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: the status and text are the evidence
  }
  return { status: response.status, headers: response.headers, text, json };
}

/**
 * What an answer says, short enough to read: Cloudflare's own error page is reduced to its title,
 * its `Error NNNN` code and its `cf-ray`; anything else is cut at 300 characters. A local copy of
 * `answerSummary` in `packages/cli/src/deploy/cloudflare.ts`, so both waits report alike.
 *
 * @param {Response} response
 * @param {string} body
 */
export function answerSummary(response, body) {
  if (!/^\s*<(?:!doctype|html)/iu.test(body)) return body.slice(0, 300);
  const title = /<title[^>]*>([^<]*)<\/title>/iu.exec(body)?.[1]?.replace(/\s+/gu, ' ').trim();
  const code = /\bError (\d{3,4})\b/u.exec(body)?.[1];
  const ray = response.headers.get('cf-ray');
  const parts = [
    title ? `title: ${title.slice(0, 120)}` : '',
    code === undefined ? '' : `code: Error ${code}`,
    ray === null ? '' : `cf-ray: ${ray.slice(0, 40)}`,
  ].filter((part) => part !== '');
  return title || code !== undefined ? parts.join('; ') : body.slice(0, 300);
}

/**
 * Polls `<control plane>/setup` until it answers 200 (auth-exempt, so a redirect is not an answer:
 * `apps/web/proxy.ts`). On exhaustion the error says what the last attempt saw: the status and the
 * start of the body, or the network error's code.
 *
 * @param {string} control
 * @param {{ fetch?: typeof fetch, windowMs?: number, delayMs?: number, requestTimeoutMs?: number }} [options]
 */
export async function awaitSetup(control, options = {}) {
  const {
    fetch: get = globalThis.fetch,
    windowMs = 600_000,
    delayMs = 5_000,
    requestTimeoutMs = 90_000,
  } = options;
  /** @type {string} */
  let last;
  const deadline = Date.now() + windowMs;
  let requests = 0;
  for (;;) {
    requests += 1;
    try {
      const response = await get(`${control}/setup`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (response.ok) return;
      last = `HTTP ${String(response.status)} ${JSON.stringify(answerSummary(response, await response.text()))}`;
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      const code =
        typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : null;
      last = `network error ${String(code ?? (error instanceof Error ? error.message : error))}`;
    }
    if (Date.now() + delayMs >= deadline) break;
    await delay(delayMs);
  }
  throw new Error(
    `the control plane did not answer ${control}/setup with 200 in ${String(windowMs / 1000)} s (${String(requests)} requests); last: ${last}`,
  );
}
