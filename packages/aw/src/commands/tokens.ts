import { TOKEN_SCOPE_KINDS } from '@indx-workspace/contracts/tokens';

import { command, enumValue, integerValue, value, type Command } from '../command.js';
import { UsageError } from '../io.js';

/**
 * §3.1 — `aw tokens mint`. Backend use only: a browser token is minted by a customer's own
 * backend and handed to its own frontend, never minted by the frontend itself. No command for the
 * workspace switch (S-2) — that is session-only, and this binary's one credential is an API key.
 */
export const tokenCommands: readonly Command[] = [
  command(
    'tokens mint',
    '--scope run|session --id <id> [--ttl <seconds>]',
    'Mint a short-lived, run- or session-scoped bearer for a customer frontend',
    async (context) => {
      const kind = enumValue(context, 'scope', TOKEN_SCOPE_KINDS);
      if (kind === undefined) {
        throw new UsageError(
          `--scope is required and must be one of ${TOKEN_SCOPE_KINDS.join(', ')}`,
        );
      }
      const id = value(context, 'id');
      if (id === undefined) throw new UsageError('--id is required');
      const ttlSeconds = integerValue(context, 'ttl');
      return {
        value: await context.client.tokens.mint(
          { kind, id },
          { ...(ttlSeconds === undefined ? {} : { ttlSeconds }), signal: context.signal },
        ),
      };
    },
  ),
];
