import { JourneyFailure } from './harness-failure.mjs';

/**
 * The fake provider answered `nonce` on `POST /v1/messages`, and the request carried `apiKey`:
 * the key the journey generated, so the reply came through the `default` model connection. The
 * key is compared, never printed.
 *
 * @param {readonly import('../generated-project/fake-anthropic.mjs').FakeRequestRecord[]} requests
 * @param {string} nonce @param {string} apiKey
 */
export function assertReplyRecorded(requests, nonce, apiKey) {
  const answered = requests.filter(
    (request) =>
      request.method === 'POST' &&
      request.path === '/v1/messages' &&
      request.reply !== null &&
      request.reply.includes(`Fake Anthropic reply to ${nonce}`),
  );
  if (answered.length === 0) throw new JourneyFailure(`the fake provider never answered ${nonce}`);
  if (!answered.some((request) => request.apiKey === apiKey)) {
    throw new JourneyFailure(
      `the fake provider answered ${nonce}, but never under the generated key`,
    );
  }
}

/**
 * The orders API saw `GET /orders/<nonce>` with `Authorization: Bearer <token>`: the gateway
 * called the tool with the sealed credential. The token is compared, never printed.
 *
 * @param {readonly { method: string, path: string, authorization: string | null }[]} calls
 * @param {string} nonce @param {string} token
 */
export function assertToolCallSeen(calls, nonce, token) {
  const route = `/orders/${nonce}`;
  const seen = calls.filter((call) => call.method === 'GET' && call.path === route);
  if (seen.length === 0) throw new JourneyFailure(`the orders API never saw GET ${route}`);
  if (!seen.some((call) => call.authorization === `Bearer ${token}`)) {
    throw new JourneyFailure(`the orders API saw GET ${route}, but never with the token`);
  }
}

/**
 * The fake model answered `nonce` with the tool's result: its reply carries `order-data-<nonce>`,
 * which only the orders API's answer holds.
 *
 * @param {readonly { method: string, path: string, reply: string | null }[]} requests
 * @param {string} nonce
 */
export function assertToolAnswer(requests, nonce) {
  const replies = requests.filter(
    (request) =>
      request.method === 'POST' &&
      request.path === '/v1/messages' &&
      request.reply?.includes(`Fake Anthropic reply to ${nonce}`) === true,
  );
  if (replies.length === 0) throw new JourneyFailure(`the fake provider never answered ${nonce}`);
  if (!replies.some((request) => request.reply?.includes(`order-data-${nonce}`) === true)) {
    throw new JourneyFailure(
      `the fake provider answered ${nonce} without the tool's data (order-data-${nonce})`,
    );
  }
}

const ORDERS_TOOL_SUFFIX = '__getOrderByOrderNumber';

/**
 * Whether the Claude CLI offered `toolName` on the agent's turn for `nonce` (the model request
 * that also offered the orders tool), as `offered` says. A tool the run's `RunRequest` denies is
 * not offered, so `Bash` absent under the ceiling, and present before it, is "Bash denied at
 * compose".
 *
 * @param {readonly { nonce: string | null, toolNames: readonly string[] }[]} toolRequests
 * @param {string} nonce @param {string} toolName @param {boolean} offered
 */
export function assertToolOffered(toolRequests, nonce, toolName, offered) {
  const turns = toolRequests.filter(
    (request) =>
      request.nonce === nonce &&
      request.toolNames.some((name) => name.endsWith(ORDERS_TOOL_SUFFIX)),
  );
  if (turns.length === 0) {
    throw new JourneyFailure(`no model request for ${nonce} offered the orders tool`);
  }
  const seen = turns.some((request) => request.toolNames.includes(toolName));
  if (seen && !offered) {
    throw new JourneyFailure(`${toolName} was offered to the model for ${nonce} under the ceiling`);
  }
  if (!seen && offered) {
    throw new JourneyFailure(
      `${toolName} was not offered to the model for ${nonce}, so its denial would prove nothing`,
    );
  }
}

/**
 * `output` holds `<file>: 403 policy_cannot_widen [permissions.runCommands]` (a hint after `; `
 * allowed): the server's dry run refused the agent. A `<file>: local policy_cannot_widen` line is
 * a refusal computed without the server and fails the check.
 *
 * @param {string} output what `aw check` or `aw dev` printed @param {string} file
 */
export function assertServerRefusal(output, file) {
  const lines = output.split('\n').map((line) => line.replace(/\r$/u, '').trim());
  if (lines.some((line) => line.includes(`${file}: local policy_cannot_widen`))) {
    throw new JourneyFailure(`policy_cannot_widen for ${file} was computed without the server`);
  }
  const expected = `${file}: 403 policy_cannot_widen [permissions.runCommands]`;
  const found = lines.some((line) => {
    const at = line.indexOf(expected);
    if (at < 0) return false;
    const rest = line.slice(at + expected.length);
    return rest === '' || rest.startsWith(';');
  });
  if (!found) throw new JourneyFailure(`no "${expected}" line`);
}

/**
 * The id of the agent named `name` in `aw agents list --json`.
 *
 * @param {string} json @param {string} name
 */
export function agentIdOf(json, name) {
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new JourneyFailure('aw agents list printed no JSON');
  }
  const list = Array.isArray(parsed) ? parsed : [];
  for (const item of list) {
    if (typeof item === 'object' && item !== null && 'name' in item && item.name === name) {
      if ('id' in item && typeof item.id === 'string') return item.id;
    }
  }
  throw new JourneyFailure(`the workspace has no agent named ${name}`);
}
