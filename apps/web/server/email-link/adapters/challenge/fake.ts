import type { ChallengeVerdict, ChallengeVerifier } from '../../ports';

/**
 * A challenge verifier for tests: it passes exactly one configured answer and records every call.
 * It contacts nothing. Never built in production: no name in `AW_EMAIL_LINK_CHALLENGE` selects it.
 */
export class FakeChallengeVerifier implements ChallengeVerifier {
  readonly #answer: string;
  readonly #calls: { readonly answer: string; readonly headers: Headers }[] = [];

  public constructor(passingAnswer: string) {
    this.#answer = passingAnswer;
  }

  public verify(answer: string, headers: Headers): Promise<ChallengeVerdict> {
    this.#calls.push({ answer, headers });
    return Promise.resolve(answer === this.#answer ? 'pass' : 'fail');
  }

  /** Every answer checked so far, oldest first. */
  public get calls(): readonly { readonly answer: string; readonly headers: Headers }[] {
    return this.#calls;
  }
}
