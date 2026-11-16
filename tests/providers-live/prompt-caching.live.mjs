/* global console */
// The Anthropic prompt-caching live check, run by .github/workflows/model-providers-live.yml.
//
// The R-03 research note on the Anthropic Messages API (Decisions, last-but-one row) keeps
// ModelCapabilities.promptCaching false for the Anthropic provider until a credential-bound replay
// shows it. This is that replay: three requests to the real API through the gateway's own provider
// row (createProviderRegistry, the code the gateway dispatches to), each response also read by the
// gateway's usage extractor, judged by prompt-caching-verdict.mjs.
//
// Needs ANTHROPIC_API_KEY. Writes the usage numbers (never the key or the model's text) to
// $PROVIDER_LIVE_OUT (default ./provider-live/prompt-caching.json) and exits 1 when the verdict
// fails. Cost: one cache write and two cache reads of a ~6,000-token prefix on a Haiku model.

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { extractResponseUsage } from '@agent-workspace/gateway';
import { createProviderRegistry } from '@agent-workspace/gateway/providers/registry';

import { judgePromptCaching } from './prompt-caching-verdict.mjs';

const MODEL = process.env.PROVIDER_LIVE_MODEL?.trim() || 'claude-haiku-5-5';
const OUT = process.env.PROVIDER_LIVE_OUT?.trim() || 'provider-live/prompt-caching.json';

const key = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
if (key === '') {
  console.error('ANTHROPIC_API_KEY is not set; the live check needs a real key.');
  process.exit(1);
}

// Above every model's documented minimum cacheable prefix (4,096 tokens at most, R-03 F7). The
// run id comes first, so no earlier run's cache can match it.
const runId = randomUUID();
const facts = Array.from(
  { length: 320 },
  (_, index) =>
    `Rule ${String(index + 1)}: a workspace keeps item ${String(index * 7 + 3)} in shelf ${String((index * 13) % 97)} and reviews it every ${String((index % 9) + 2)} days.`,
).join('\n');
const system = [
  {
    type: 'text',
    text: `Check ${runId}. Answer in one word.\n\n${facts}`,
    cache_control: { type: 'ephemeral' },
  },
];

/** @param {boolean} stream */
const body = (stream) => ({
  model: MODEL,
  max_tokens: 8,
  system,
  messages: [{ role: 'user', content: 'Reply with the word ok.' }],
  ...(stream ? { stream: true } : {}),
});

const anthropic = createProviderRegistry().find((provider) => provider.id === 'anthropic');
if (anthropic === undefined) throw new Error('the provider registry has no anthropic row');

/**
 * The upstream usage from the response itself, and what the gateway's extractor records from a
 * copy of it. For a stream the counters of message_start and message_delta are merged (the
 * cache counters arrive in message_start).
 * @param {boolean} stream
 */
async function call(stream) {
  const response = await anthropic.createMessage(body(stream), {
    providerId: 'anthropic',
    credential: key,
    requestId: `prompt-caching-live-${runId}`,
    settings: {},
  });
  if (!response.ok) {
    throw new Error(
      `the API answered HTTP ${String(response.status)}: ${(await response.text()).slice(0, 300)}`,
    );
  }
  const recorded = await extractResponseUsage(response.clone(), 'anthropic-messages');
  /** @type {Record<string, unknown>} */
  let upstream = {};
  if (stream) {
    for (const raw of (await response.text()).split('\n')) {
      const line = raw.trimEnd();
      if (!line.startsWith('data:')) continue;
      const event = JSON.parse(line.slice(5));
      const usage =
        event.type === 'message_start'
          ? event.message?.usage
          : event.type === 'message_delta'
            ? event.usage
            : undefined;
      // A later frame's null or absent counter must not erase the one message_start reported.
      for (const [name, value] of Object.entries(usage ?? {})) {
        if (typeof value === 'number') upstream[name] = value;
      }
    }
  } else {
    upstream = (await response.json()).usage ?? {};
  }
  return {
    upstream: /** @type {import('./prompt-caching-verdict.mjs').AnthropicUsage} */ (
      /** @type {unknown} */ ({
        input_tokens: upstream['input_tokens'],
        output_tokens: upstream['output_tokens'],
        cache_creation_input_tokens: upstream['cache_creation_input_tokens'],
        cache_read_input_tokens: upstream['cache_read_input_tokens'],
      })
    ),
    recorded: {
      inputTokens: recorded.inputTokens,
      cacheReadInputTokens: recorded.cacheReadInputTokens,
      cacheCreationInputTokens: recorded.cacheCreationInputTokens,
    },
  };
}

const first = await call(false);
const second = await call(false);
const streamed = await call(true);
const verdict = judgePromptCaching({ first, second, streamed });

const evidence = {
  check: 'anthropic prompt caching through the gateway provider row',
  model: MODEL,
  at: new Date().toISOString(),
  calls: { first, second, streamed },
  verdict,
};
await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, `${JSON.stringify(evidence, null, 2)}\n`);

const rows = Object.entries({ first, second, streamed })
  .map(
    ([name, { upstream }]) =>
      `| ${name} | ${String(upstream.input_tokens)} | ${String(upstream.cache_creation_input_tokens)} | ${String(upstream.cache_read_input_tokens)} |`,
  )
  .join('\n');
console.log(
  [
    `Prompt caching on ${MODEL}: ${verdict.ok ? 'verified' : 'NOT verified'}`,
    '',
    '| call | input_tokens | cache write | cache read |',
    '| --- | --- | --- | --- |',
    rows,
    '',
    `input_tokens counts: ${verdict.inputTokensMeaning}`,
    ...verdict.failures.map((failure) => `- ${failure}`),
  ].join('\n'),
);
if (!verdict.ok) process.exitCode = 1;
