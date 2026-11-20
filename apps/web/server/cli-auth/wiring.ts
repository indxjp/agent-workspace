/**
 * The seam between `/api/auth/cli-*` (issue #242, SDK-10, S-22) and the `cli_sessions`
 * repository. The composition root builds it once and installs it as `ApplicationContext.cliAuth`;
 * with no context installed every CLI sign-in route answers `503 cli_auth_not_configured`.
 */
import type { CliSessionRepository } from '@agent-workspace/core/db';

export interface CliAuthRuntime {
  readonly sessions: CliSessionRepository;
  /** The deployment's session secret; the device code's MAC key. */
  readonly secret: string;
}
