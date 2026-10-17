/**
 * The expert's half of the loop: a retiring expert reads the cases the agent resolved (and the
 * ones it escalated) and marks each run right or wrong, with the correction in their words.
 *
 * The rating is the platform's own feedback (`aw.runs.rate`, the same call the surface's rating
 * buttons make), so a thumbs-down with the expert's correction is what `aw eval add-case <runId>`
 * turns into an evaluation case: the expert's knowledge becomes a check every later version of the
 * agent must pass before `aw promote`.
 */
import { RUN_FEEDBACK_COMMENT_MAX_LENGTH } from '@indx-workspace/contracts/feedback';
import type { AgentWorkspaceClient } from '@indx-workspace/sdk';

import { DiagnosisError } from './diagnose.ts';

export interface ExpertReview {
  readonly runId: string;
  readonly expert: string;
  readonly correct: boolean;
  /** Required when `correct` is false: what the right step or cause was. */
  readonly correction?: string;
}

/** Record `review` as the run's feedback; returns the comment it sent. */
export async function submitExpertReview(
  aw: AgentWorkspaceClient,
  review: ExpertReview,
): Promise<string> {
  const expert = review.expert.trim();
  const correction = review.correction?.trim() ?? '';
  if (expert === '') throw new DiagnosisError('invalid_input', 'expert must not be blank');
  if (!review.correct && correction === '') {
    throw new DiagnosisError('invalid_input', 'a wrong answer needs the expert’s correction');
  }
  const comment = review.correct
    ? `熟練者確認済み（${expert}）`
    : `熟練者訂正（${expert}）: ${correction}`;
  if ([...comment].length > RUN_FEEDBACK_COMMENT_MAX_LENGTH) {
    throw new DiagnosisError('invalid_input', 'the correction is too long');
  }
  await aw.runs.rate(review.runId, { rating: review.correct ? 'up' : 'down', comment });
  return comment;
}
