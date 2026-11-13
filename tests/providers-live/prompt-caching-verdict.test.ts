import { describe, expect, it } from 'vitest';

import { judgePromptCaching } from './prompt-caching-verdict.mjs';

type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

const usage = (input: number, write: number, read: number): Usage => ({
  input_tokens: input,
  output_tokens: 2,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
});

/** A call whose recorded usage is what the gateway extractor would settle from it. */
const call = (upstream: Usage) => ({
  upstream,
  recorded: {
    inputTokens: upstream.input_tokens,
    cacheReadInputTokens: upstream.cache_read_input_tokens,
    cacheCreationInputTokens: upstream.cache_creation_input_tokens,
  },
});

const working = () => ({
  first: call(usage(14, 6200, 0)),
  second: call(usage(14, 0, 6200)),
  streamed: call(usage(14, 0, 6200)),
});

describe('the Anthropic prompt-caching live verdict', () => {
  it('passes a cache write followed by two reads of the same size', () => {
    expect(judgePromptCaching(working())).toEqual({
      ok: true,
      failures: [],
      cachedTokens: 6200,
      inputTokensMeaning: 'after-the-cached-prefix',
    });
  });

  it('names input_tokens a total when it covers the cached prefix', () => {
    const verdict = judgePromptCaching({
      first: call(usage(6214, 6200, 0)),
      second: call(usage(6214, 0, 6200)),
      streamed: call(usage(6214, 0, 6200)),
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.inputTokensMeaning).toBe('total');
  });

  it('fails when nothing is cached (a prefix under the minimum, or caching off)', () => {
    const verdict = judgePromptCaching({
      first: call(usage(6214, 0, 0)),
      second: call(usage(6214, 0, 0)),
      streamed: call(usage(6214, 0, 0)),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toContain(
      'first call: wrote no cache (cache_creation_input_tokens is 0)',
    );
  });

  it('fails when the first call reads a cache an earlier run left', () => {
    const calls = working();
    calls.first = call(usage(14, 6200, 100));
    expect(judgePromptCaching(calls).failures).toContain(
      'first call: read a cache, so the run-unique prefix was not unique',
    );
  });

  it.each(['second', 'streamed'] as const)(
    'fails when the %s call does not read the cache',
    (name) => {
      const calls = working();
      calls[name] = call(usage(14, 6200, 0));
      const verdict = judgePromptCaching(calls);
      expect(verdict.ok).toBe(false);
      expect(verdict.failures).toContain(
        `${name} call: read 0 cached tokens, expected the 6200 the first call wrote`,
      );
      expect(verdict.failures).toContain(
        `${name} call: wrote the cache again instead of reading it`,
      );
    },
  );

  it('fails when a read covers only part of what was written', () => {
    const calls = working();
    calls.second = call(usage(14, 0, 6100));
    expect(judgePromptCaching(calls).ok).toBe(false);
  });

  it.each([
    ['cacheReadInputTokens', 'cache-read'],
    ['cacheCreationInputTokens', 'cache-write'],
    ['inputTokens', 'input'],
  ] as const)(
    'fails when the gateway records a different %s than the API reported',
    (field, words) => {
      const calls = working();
      calls.second = { ...calls.second, recorded: { ...calls.second.recorded, [field]: 1 } };
      const verdict = judgePromptCaching(calls);
      expect(verdict.ok).toBe(false);
      expect(
        verdict.failures.some((failure) =>
          failure.startsWith(`second call: the gateway recorded 1 ${words} tokens`),
        ),
      ).toBe(true);
    },
  );

  it('fails when a usage counter is missing', () => {
    const calls = working();
    const broken = { ...calls.streamed.upstream } as Partial<Usage>;
    delete broken.cache_read_input_tokens;
    calls.streamed = { upstream: broken as Usage, recorded: calls.streamed.recorded };
    expect(judgePromptCaching(calls).failures).toContain(
      'streamed call: usage.cache_read_input_tokens is missing or not a whole number',
    );
  });

  it('fails when input_tokens changes between calls of the same prompt', () => {
    const calls = working();
    calls.second = call(usage(6214, 0, 6200));
    const verdict = judgePromptCaching(calls);
    expect(verdict.inputTokensMeaning).toBe('neither');
    expect(verdict.ok).toBe(false);
  });
});
