import { MODEL_PROVIDERS } from '@indx-workspace/contracts/runs';
import { describe, expect, it } from 'vitest';

import { DEPLOYMENT_DEFAULT_MODELS_ENV, readDeploymentDefaultModels } from './deployment-default';

function read(value: string | undefined) {
  return readDeploymentDefaultModels({ [DEPLOYMENT_DEFAULT_MODELS_ENV]: value });
}

function refusalReason(value: string): string {
  const result = read(value);
  if (result.ok) throw new Error('expected the value to be refused');
  expect(result.reason).toContain(DEPLOYMENT_DEFAULT_MODELS_ENV);
  return result.reason;
}

describe('readDeploymentDefaultModels', () => {
  it('treats an unset or blank variable as an empty map', () => {
    expect(readDeploymentDefaultModels({})).toEqual({ ok: true, defaults: {} });
    expect(read('')).toEqual({ ok: true, defaults: {} });
    expect(read('   ')).toEqual({ ok: true, defaults: {} });
  });

  it('accepts a per-provider map and trims each id', () => {
    expect(read('{"anthropic":" claude-sonnet-4-5 ","openai":"gpt-5.1"}')).toEqual({
      ok: true,
      defaults: { anthropic: 'claude-sonnet-4-5', openai: 'gpt-5.1' },
    });
    expect(read('{}')).toEqual({ ok: true, defaults: {} });
  });

  it('accepts every model provider as a key', () => {
    const all = Object.fromEntries(MODEL_PROVIDERS.map((provider) => [provider, 'model-id']));
    expect(read(JSON.stringify(all))).toEqual({ ok: true, defaults: all });
  });

  it('refuses a key that is not a model provider without echoing it', () => {
    const reason = refusalReason('{"antropic-secret-typo":"claude-sonnet-4-5"}');
    expect(reason).toContain('not a model provider');
    expect(reason).not.toContain('antropic-secret-typo');
    expect(reason).not.toContain('claude-sonnet-4-5');
  });

  it('refuses a blank id', () => {
    expect(refusalReason('{"anthropic":"   "}')).toContain('"anthropic" entry is blank');
  });

  it('refuses an id with inner whitespace or control characters without echoing it', () => {
    const reason = refusalReason('{"anthropic":"claude sonnet-secret"}');
    expect(reason).toContain('whitespace, control or invisible format characters');
    expect(reason).not.toContain('sonnet-secret');
    expect(refusalReason('{"openai":"gpt\\u0007x"}')).toContain('"openai" entry');
  });

  // The review of #506: zero-width and bidi-override characters make a look-alike id.
  it('refuses an id with invisible format characters', () => {
    for (const codePoint of [0x200b, 0x202e, 0x2060]) {
      const id = `claude${String.fromCodePoint(codePoint)}sonnet`;
      const reason = refusalReason(JSON.stringify({ anthropic: id }));
      expect(reason).toContain(
        '"anthropic" entry contains whitespace, control or invisible format',
      );
    }
  });

  it('refuses an over-long id without echoing it', () => {
    const reason = refusalReason(JSON.stringify({ anthropic: 'x'.repeat(201) }));
    expect(reason).toContain('longer than 200 characters');
    expect(reason).not.toContain('x'.repeat(20));
    expect(read(JSON.stringify({ anthropic: 'x'.repeat(200) })).ok).toBe(true);
  });

  it('refuses a non-string id', () => {
    expect(refusalReason('{"anthropic":42}')).toContain('"anthropic" entry is not a string');
  });

  it('refuses non-JSON without echoing the value', () => {
    const reason = refusalReason('anthropic=claude-sonnet-4-5');
    expect(reason).toContain('not valid JSON');
    expect(reason).not.toContain('claude-sonnet-4-5');
  });

  it('refuses an array, a string and null without echoing them', () => {
    for (const value of ['["claude-sonnet-4-5"]', '"claude-sonnet-4-5"', 'null']) {
      const reason = refusalReason(value);
      expect(reason).toContain('not a JSON object keyed by model provider');
      expect(reason).not.toContain('claude-sonnet-4-5');
    }
  });
});
