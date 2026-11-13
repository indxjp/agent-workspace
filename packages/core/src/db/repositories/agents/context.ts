import type { SQL } from 'drizzle-orm';

import type { Executor } from '../agent-versions-shared.js';
import type { WorkspaceScope } from '../scope.js';

/** What every agent repository part shares: the handle and the scope's tenant predicate. */
export interface AgentContext {
  readonly db: Executor;
  readonly checked: WorkspaceScope;
  readonly tenant: SQL;
  /** `tenant` and `rest`, with the workspace predicate first. */
  readonly within: (rest: SQL) => SQL;
}
