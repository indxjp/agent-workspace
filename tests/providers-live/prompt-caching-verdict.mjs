// The verdict of the Anthropic prompt-caching live check (R-03: "W4-GW-01 must replay … against
// the real API … Until then the gateway must declare … promptCaching as unverified"). Pure, so the
// unit test can feed it recorded and broken usage without a key; prompt-caching.live.mjs feeds it
// the three real responses.
//
// The three calls share one system prefix that carries `cache_control` and starts with a value
// unique to the run, so the first call cannot hit a cache an earlier run left:
//   first    non-streaming, writes the cache
//   second   non-streaming, the same request again, reads it
//   streamed streaming, the same request again, reads it (Claude Code streams)

/**
 * @typedef {{
 *   input_tokens: number,
 *   output_tokens: number,
 *   cache_creation_input_tokens: number,
 *   cache_read_input_tokens: number,
 * }} AnthropicUsage
 * @typedef {{ inputTokens: number, cacheReadInputTokens: number, cacheCreationInputTokens: number }} GatewayUsage
 * @typedef {{ upstream: AnthropicUsage, recorded: GatewayUsage }} CallUsage
 * @typedef {{
 *   ok: boolean,
 *   failures: string[],
 *   cachedTokens: number,
 *   inputTokensMeaning: 'after-the-cached-prefix' | 'total' | 'neither',
 * }} Verdict
 */

/** @param {unknown} value */
const count = (value) =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;

/**
 * @param {string} label
 * @param {CallUsage} call
 * @param {string[]} failures
 */
function checkRecorded(label, call, failures) {
  const { upstream, recorded } = call;
  for (const key of ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    if (count(upstream[/** @type {keyof AnthropicUsage} */ (key)]) === null) {
      failures.push(`${label}: usage.${key} is missing or not a whole number`);
    }
  }
  // What the gateway settles the run with must be what the API reported.
  if (recorded.cacheReadInputTokens !== upstream.cache_read_input_tokens) {
    failures.push(
      `${label}: the gateway recorded ${String(recorded.cacheReadInputTokens)} cache-read tokens, the API reported ${String(upstream.cache_read_input_tokens)}`,
    );
  }
  if (recorded.cacheCreationInputTokens !== upstream.cache_creation_input_tokens) {
    failures.push(
      `${label}: the gateway recorded ${String(recorded.cacheCreationInputTokens)} cache-write tokens, the API reported ${String(upstream.cache_creation_input_tokens)}`,
    );
  }
  if (recorded.inputTokens !== upstream.input_tokens) {
    failures.push(
      `${label}: the gateway recorded ${String(recorded.inputTokens)} input tokens, the API reported ${String(upstream.input_tokens)}`,
    );
  }
}

/**
 * @param {{ first: CallUsage, second: CallUsage, streamed: CallUsage }} calls
 * @returns {Verdict}
 */
export function judgePromptCaching({ first, second, streamed }) {
  /** @type {string[]} */
  const failures = [];
  checkRecorded('first call', first, failures);
  checkRecorded('second call', second, failures);
  checkRecorded('streamed call', streamed, failures);

  const written = first.upstream.cache_creation_input_tokens;
  if (!(written > 0))
    failures.push('first call: wrote no cache (cache_creation_input_tokens is 0)');
  if (first.upstream.cache_read_input_tokens !== 0) {
    failures.push('first call: read a cache, so the run-unique prefix was not unique');
  }
  for (const [label, call] of /** @type {const} */ ([
    ['second call', second],
    ['streamed call', streamed],
  ])) {
    if (call.upstream.cache_read_input_tokens !== written || !(written > 0)) {
      failures.push(
        `${label}: read ${String(call.upstream.cache_read_input_tokens)} cached tokens, expected the ${String(written)} the first call wrote`,
      );
    }
    if (call.upstream.cache_creation_input_tokens !== 0) {
      failures.push(`${label}: wrote the cache again instead of reading it`);
    }
  }

  // R-03's open question (fixtures/anthropic/index.json, messages-cache-hit): is input_tokens the
  // total, or only what follows the cached prefix? The prefix is thousands of tokens and the rest a
  // few dozen, so a total cannot be smaller than the cached part, and a remainder cannot reach it.
  // Either way it must not change between a cache write and a cache read of the same prompt.
  const sameRemainder =
    first.upstream.input_tokens === second.upstream.input_tokens &&
    first.upstream.input_tokens === streamed.upstream.input_tokens;
  /** @type {Verdict['inputTokensMeaning']} */
  const inputTokensMeaning =
    !sameRemainder || !(written > 0)
      ? 'neither'
      : first.upstream.input_tokens < written
        ? 'after-the-cached-prefix'
        : 'total';
  if (!sameRemainder) {
    failures.push(
      'input_tokens changed between calls of the same prompt, so the token arithmetic is unknown',
    );
  }

  return { ok: failures.length === 0, failures, cachedTokens: written, inputTokensMeaning };
}
