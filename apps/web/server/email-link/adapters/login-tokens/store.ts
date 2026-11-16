import type { LoginTokenRepository } from '@agent-workspace/core/db';

import type { ConsumeOutcome, LoginTokenStore } from '../../ports';

export type { LoginTokenRepository };

/** The production {@link LoginTokenStore}: the `login_tokens` repository, one statement per call. */
export function createLoginTokenStore(repository: LoginTokenRepository): LoginTokenStore {
  return {
    reserve: (record, window) => repository.reserve(record, window),
    release: (id) => repository.release(id),
    async consume(input): Promise<ConsumeOutcome> {
      return (await repository.consume(input)) ? { kind: 'consumed' } : { kind: 'refused' };
    },
  };
}
