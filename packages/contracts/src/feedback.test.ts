import { describe, expect, it } from 'vitest';

import {
  RUN_FEEDBACK_COMMENT_MAX_LENGTH,
  RUN_FEEDBACK_RATINGS,
  RunFeedbackItemSchema,
  RunFeedbackListQuerySchema,
  RunFeedbackListResponseSchema,
  RunFeedbackRequestSchema,
} from './feedback.js';

function paths(value: unknown): readonly string[] {
  const parsed = RunFeedbackRequestSchema.safeParse(value);
  if (parsed.success) throw new Error('expected the feedback to be refused');
  return parsed.error.issues.map((issue) => issue.path.map(String).join('.'));
}

describe('RunFeedbackRequestSchema (C19; #537)', () => {
  it.each([{ rating: 'up' }, { rating: 'down', comment: 'Wrong order number.' }])(
    'parses %j unchanged and frozen',
    (body) => {
      const parsed = RunFeedbackRequestSchema.parse(body);
      expect(parsed).toEqual(body);
      expect(Object.isFrozen(parsed)).toBe(true);
    },
  );

  it('accepts a comment at the maximum length and refuses one over it', () => {
    const comment = 'a'.repeat(RUN_FEEDBACK_COMMENT_MAX_LENGTH);
    expect(RunFeedbackRequestSchema.parse({ rating: 'up', comment })).toEqual({
      rating: 'up',
      comment,
    });
    expect(paths({ rating: 'up', comment: `${comment}a` })).toEqual(['comment']);
  });

  it.each([
    [{ rating: 'meh' }, 'rating'],
    [{}, 'rating'],
    [{ rating: 'down', comment: '   ' }, 'comment'],
    [{ rating: 'up', runId: '11111111-1111-4111-8111-111111111111' }, ''],
  ])('refuses %j at %j', (body, path) => {
    expect(paths(body)).toEqual([path]);
  });

  it('exports the ratings', () => {
    expect(RUN_FEEDBACK_RATINGS).toEqual(['up', 'down']);
    expect(RUN_FEEDBACK_COMMENT_MAX_LENGTH).toBe(1000);
  });
});

describe('RunFeedbackListQuerySchema and RunFeedbackItemSchema (#620)', () => {
  const runId = '11111111-1111-4111-8111-111111111111';

  it('takes no key, or any of rating, since and runId', () => {
    expect(RunFeedbackListQuerySchema.parse({})).toEqual({});
    const query = { rating: 'down', since: '2026-10-01T00:00:00.000Z', runId };
    expect(RunFeedbackListQuerySchema.parse(query)).toEqual(query);
  });

  it.each([{ rating: 'meh' }, { since: 'last week' }, { runId: 'run_1' }, { limit: '5' }])(
    'refuses %j',
    (query) => {
      expect(RunFeedbackListQuerySchema.safeParse(query).success).toBe(false);
    },
  );

  it('answers items with a nullable comment and input', () => {
    const item = {
      runId,
      rating: 'down',
      comment: null,
      input: null,
      answer: '',
      createdAt: '2026-10-01T00:00:00.000Z',
    };
    expect(RunFeedbackListResponseSchema.parse({ items: [item] })).toEqual({ items: [item] });
    expect(RunFeedbackItemSchema.safeParse({ ...item, prompt: 'hi' }).success).toBe(false);
  });
});
