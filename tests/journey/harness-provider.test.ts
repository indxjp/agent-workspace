import { failureOf, record, NONCE, KEY } from './harness-fixtures.js';
import { describe, expect, it } from 'vitest';
import { assertReplyRecorded } from './harness.mjs';

describe('the reply through the default model connection', () => {
  it('passes on a POST /v1/messages that answered the nonce under the generated key', () => {
    expect(() =>
      assertReplyRecorded(
        [record({ method: 'GET', path: '/v1/models', reply: null }), record({})],
        NONCE,
        KEY,
      ),
    ).not.toThrow();
  });

  it('fails when no reply names the nonce', () => {
    const failure = failureOf(() =>
      assertReplyRecorded(
        [
          record({
            reply: 'Fake Anthropic reply to e2e-nonce-other: the generated project answered.',
          }),
        ],
        NONCE,
        KEY,
      ),
    );
    expect(failure.message).toBe(`the fake provider never answered ${NONCE}`);
  });

  it('fails when the reply came under another key, and never prints either key', () => {
    const failure = failureOf(() =>
      assertReplyRecorded([record({ apiKey: 'sk-ant-e2e-fake-other' })], NONCE, KEY),
    );
    expect(failure.message).toBe(
      `the fake provider answered ${NONCE}, but never under the generated key`,
    );
    expect(failure.message).not.toContain(KEY);
    expect(failure.message).not.toContain('sk-ant-e2e-fake-other');
  });
});
