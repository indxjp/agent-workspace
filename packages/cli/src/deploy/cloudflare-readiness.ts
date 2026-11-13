import { setTimeout as sleep } from 'node:timers/promises';
import type { DeployContext } from './steps.ts';

/**
 * Ten minutes: a first deploy provisions the container before it can start. A request may take up to
 * 90 s, the Worker's own wait for the container, so a slow first start reaches the caller as the
 * Worker's 503 and its reason rather than as an abort.
 */
const DEFAULT_READINESS = { windowMs: 600_000, delayMs: 5_000, requestTimeoutMs: 90_000 };

const HTML_ANSWER = /^\s*<(?:!doctype|html)/iu;
const CONTAINER_EXITED = /container exited/iu;

/**
 * What an answer says, short enough to read: Cloudflare's own error page is reduced to its title,
 * its `Error NNNN` code and the `cf-ray` that finds it in the dashboard; anything else is cut at
 * 300 characters.
 */
function answerSummary(response: Response, body: string): string {
  if (!HTML_ANSWER.test(body)) return body.slice(0, 300);
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
 * Waits until a container Worker answers `GET <url>` with 200 (the control plane's `/setup` and the
 * runner manager's `/healthz` are both auth-exempt, so a redirect is not an answer). `wrangler
 * deploy` returns before the container exists: Cloudflare starts it on the first request, and the
 * Worker answers 503 with the reason until it can serve. What the last request saw goes to stderr,
 * redacted; the error carries only the status or the failure's name.
 */
export async function waitForWorker(
  context: DeployContext,
  label: 'control plane' | 'runner manager',
  workerName: string,
  url: string,
): Promise<void> {
  const { windowMs, delayMs, requestTimeoutMs } = context.readiness ?? DEFAULT_READINESS;
  const get = context.fetch ?? globalThis.fetch;
  context.out(`Waiting for the ${label} at ${url} to answer.\n`);
  let last: string;
  let seen: string;
  const deadline = Date.now() + windowMs;
  let requests = 0;
  for (;;) {
    requests += 1;
    const answer = await probeWorker(get, url, requestTimeoutMs);
    if (answer === null) return;
    ({ last, seen } = answer);
    if (Date.now() + delayMs >= deadline) break;
    await sleep(delayMs);
  }
  context.err(`Last answer from ${url}: ${last} ${JSON.stringify(seen)}\n`);
  throw new Error(
    `The ${label} Worker ${workerName} did not answer ${url} with 200 in ` +
      `${String(windowMs / 1000)} s (${String(requests)} requests); last: ${last}. The Workers and secrets were applied; its ` +
      `answer is above. Run deploy again, or watch \`wrangler tail ${workerName}\`.` +
      (CONTAINER_EXITED.test(seen)
        ? ' The container exited: the reason it printed is in its log (Cloudflare dashboard, ' +
          `Compute > Containers > ${workerName}), not in this answer.`
        : ''),
  );
}

async function probeWorker(get: typeof fetch, url: string, requestTimeoutMs: number) {
  try {
    const response = await get(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (response.status === 200) return null;
    return {
      last: `HTTP ${String(response.status)}`,
      seen: answerSummary(response, await response.text()),
    };
  } catch (error) {
    return {
      last: `network error (${error instanceof Error ? error.name : 'unknown'})`,
      seen: error instanceof Error && error.cause instanceof Error ? error.cause.message : '',
    };
  }
}
