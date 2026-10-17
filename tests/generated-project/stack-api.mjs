/* global fetch, AbortSignal */
/**
 * The HTTP calls the generated-project E2E makes against a running project, as a new user's
 * scripts would: the public `/api/**` routes only, with the session cookie `POST /api/setup` sets
 * (and the `Origin` header every cookie-authenticated write needs) or with an `ak_live_` key.
 */
import { URL } from 'node:url';

/**
 * Split a `text/event-stream` body into frames (`apps/web/server/runs/sse.ts`'s format): `event:`,
 * optional `id:` and one `data:` line per frame; comments and `retry:` lines are not frames.
 *
 * @param {string} body
 * @returns {{ event: string, id: string | null, data: unknown }[]}
 */
export function parseSseFrames(body) {
  const frames = [];
  for (const block of body.split(/\r?\n\r?\n/u)) {
    let event = 'message';
    let id = null;
    const data = [];
    for (const line of block.split(/\r?\n/u)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /u, ''));
    }
    if (data.length === 0) continue;
    const text = data.join('\n');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    frames.push({ event, id, data: parsed });
  }
  return frames;
}

/**
 * The assistant text of a run's frames: the `blocks` of every `agent.message` whose role is
 * `assistant` (`packages/contracts/src/run-events.ts`).
 *
 * @param {readonly { event: string, data: unknown }[]} frames
 */
export function assistantText(frames) {
  const texts = [];
  for (const frame of frames) {
    if (frame.event !== 'agent.message') continue;
    const data = /** @type {{ role?: unknown, blocks?: unknown }} */ (frame.data);
    if (data.role !== 'assistant' || !Array.isArray(data.blocks)) continue;
    for (const block of data.blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    }
  }
  return texts.join('\n');
}

/**
 * The terminal status a run's frames report: the last `run.status` frame's status, or the
 * `run-failed` frame's when the stream says the run did not complete.
 *
 * @param {readonly { event: string, data: unknown }[]} frames
 */
export function terminalStatus(frames) {
  let status = null;
  for (const frame of frames) {
    const data = /** @type {{ status?: unknown }} */ (frame.data);
    if (
      (frame.event === 'run.status' || frame.event === 'run-failed') &&
      typeof data.status === 'string'
    ) {
      status = data.status;
    }
  }
  return status;
}

/** @param {string} text */
function jsonOrNull(text) {
  try {
    return text === '' ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/** A client for one running project. */
export class StackClient {
  /** @param {string} baseUrl e.g. `http://127.0.0.1:3000` */
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/u, '');
    /** @type {string | null} */
    this.cookie = null;
  }

  /**
   * @param {string} route @param {{ method?: string, body?: unknown, apiKey?: string, timeoutMs?: number }} [options]
   */
  async request(route, options = {}) {
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' };
    if (options.apiKey !== undefined) headers['authorization'] = `Bearer ${options.apiKey}`;
    else if (this.cookie !== null) headers['cookie'] = this.cookie;
    const method = options.method ?? 'GET';
    // A cookie-authenticated write must name the origin it is sent from (apps/web/proxy.ts).
    if (method !== 'GET') headers['origin'] = new URL(this.baseUrl).origin;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const response = await fetch(`${this.baseUrl}${route}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, json: jsonOrNull(text) };
  }

  /**
   * `POST /api/setup`, keeping the session cookie it sets.
   * @param {Record<string, string>} body
   */
  async setup(body) {
    const response = await this.request('/api/setup', { method: 'POST', body, timeoutMs: 180_000 });
    // Every cookie the answer sets, by name and value only: the session cookie's name is the
    // server's to choose (#406 scoped it per project), and the test must not depend on it.
    const cookies = response.headers.getSetCookie().map((cookie) => cookie.split(';')[0] ?? '');
    if (cookies.length > 0) this.cookie = cookies.join('; ');
    return response;
  }

  /**
   * Read a run's event stream to its end (`done`) and return the frames.
   * @param {string} runId @param {{ apiKey?: string, timeoutMs?: number }} [options]
   */
  async runFrames(runId, options = {}) {
    const response = await this.request(`/api/runs/${runId}/events`, {
      ...options,
      timeoutMs: options.timeoutMs ?? 180_000,
    });
    if (response.status !== 200) {
      throw new Error(
        `GET /api/runs/${runId}/events answered ${String(response.status)}: ${response.text}`,
      );
    }
    return parseSseFrames(response.text);
  }
}
