import { describe, expect, it } from 'vitest';

import {
  ApiProblemBareCodeSchema,
  ApiProblemDetailSchema,
  ApiProblemSchema,
  COMMON_PROBLEM_CODES,
  IN_USE_REFERRER_KINDS,
  formatInUseReferrer,
  parseInUseReferrers,
} from './problem.js';

describe('ApiProblemSchema', () => {
  it('accepts the envelope with and without details', () => {
    expect(
      ApiProblemSchema.safeParse({ error: { code: 'forbidden', message: 'No.' } }).success,
    ).toBe(true);
    expect(
      ApiProblemSchema.safeParse({
        error: { code: 'invalid_field', message: 'Bad.', details: ['name is required'] },
      }).success,
    ).toBe(true);
  });

  it('refuses an empty code, a bare string, an unknown key, and a missing message', () => {
    expect(ApiProblemSchema.safeParse({ error: { code: '', message: 'x' } }).success).toBe(false);
    expect(ApiProblemSchema.safeParse({ error: 'boom' }).success).toBe(false);
    expect(
      ApiProblemSchema.safeParse({ error: { code: 'x', message: 'y', status: 400 } }).success,
    ).toBe(false);
    expect(ApiProblemSchema.safeParse({ error: { code: 'x' } }).success).toBe(false);
  });

  it('accepts the deprecated detail duplicate next to message, and nothing else beside it', () => {
    expect(
      ApiProblemSchema.safeParse({ error: { code: 'forbidden', message: 'No.', detail: 'No.' } })
        .success,
    ).toBe(true);
    expect(
      ApiProblemSchema.safeParse({
        error: { code: 'x', message: 'y', details: ['a'], detail: 'y' },
      }).success,
    ).toBe(true);
    expect(
      ApiProblemSchema.safeParse({ error: { code: 'x', message: 'y', detail: 1 } }).success,
    ).toBe(false);
    expect(
      ApiProblemSchema.safeParse({ error: { code: 'x', message: 'y', detail: 'y', status: 400 } })
        .success,
    ).toBe(false);
  });

  it('keeps the detail-only envelope of an older deployment apart from the standard one', () => {
    const detail = { error: { code: 'last_owner', detail: 'The last owner cannot leave.' } };
    expect(ApiProblemDetailSchema.safeParse(detail).success).toBe(true);
    expect(ApiProblemSchema.safeParse(detail).success).toBe(false);
    expect(ApiProblemDetailSchema.safeParse({ error: { code: 'x', message: 'y' } }).success).toBe(
      false,
    );
    expect(
      ApiProblemDetailSchema.safeParse({ error: { code: 'x', detail: 'y', details: [] } }).success,
    ).toBe(false);
    expect(
      ApiProblemDetailSchema.safeParse({ error: { code: 'x', detail: 'y', message: 'y' } }).success,
    ).toBe(false);
  });

  it('keeps the bare-code envelope of runtimes/test apart from the others', () => {
    expect(ApiProblemBareCodeSchema.safeParse({ error: 'invalid_limit' }).success).toBe(true);
    expect(
      ApiProblemBareCodeSchema.safeParse({ error: 'driver_unavailable', message: 'No docker.' })
        .success,
    ).toBe(true);
    expect(ApiProblemBareCodeSchema.safeParse({ error: '' }).success).toBe(false);
    expect(ApiProblemBareCodeSchema.safeParse({ error: 'x', code: 'y' }).success).toBe(false);
    expect(ApiProblemBareCodeSchema.safeParse({ error: { code: 'x', message: 'y' } }).success).toBe(
      false,
    );
    expect(ApiProblemSchema.safeParse({ error: 'invalid_limit' }).success).toBe(false);
  });

  it('maps every common code to the status it travels under', () => {
    expect(COMMON_PROBLEM_CODES.unauthenticated).toBe(401);
    expect(COMMON_PROBLEM_CODES.forbidden).toBe(403);
    expect(COMMON_PROBLEM_CODES.request_body_too_large).toBe(413);
    expect(COMMON_PROBLEM_CODES.service_unavailable).toBe(503);
  });
});

describe('the in-use referrer rule (ADR-0077)', () => {
  const agent = '77777777-7777-4777-8777-777777777777';
  const connector = '55555555-5555-4555-8555-555555555555';

  it('formats and parses every referrer kind round trip', () => {
    const referrers = IN_USE_REFERRER_KINDS.map((kind) => ({ kind, id: agent }));
    expect(parseInUseReferrers(referrers.map(formatInUseReferrer))).toEqual(referrers);
    expect(formatInUseReferrer({ kind: 'connector', id: connector })).toBe(
      `connector:${connector}`,
    );
  });

  it('skips a detail that is not a referrer rather than guessing', () => {
    expect(
      parseInUseReferrers(['name: too long', `project:${agent}`, `agent:${agent}`, 'agent:x']),
    ).toEqual([{ kind: 'agent', id: agent }]);
  });
});
