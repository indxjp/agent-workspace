import { CONTRACTS_VERSION } from '@indx-workspace/contracts';

/**
 * This package's version; equal to `packages/cli/package.json`'s, pinned by `index.test.ts`.
 * `agent-workspace --version` prints it, the same way `aw --version` prints `aw`'s (issue #416).
 */
export const CLI_VERSION = '0.6.12';

/** What `agent-workspace --version` prints: the CLI and the contracts version it was built against. */
export function versionText(): string {
  return `agent-workspace ${CLI_VERSION} (contracts ${CONTRACTS_VERSION})\n`;
}
