import type { SQL } from 'drizzle-orm';
import type { Database } from '../../client.js';
import type { WorkspaceScope } from '../scope.js';
import type { RunRecord } from './types.js';
export interface RunContext {
  readonly db: Database;
  readonly checked: WorkspaceScope;
  readonly tenant: SQL;
  readonly read: (runId: string) => Promise<RunRecord | null>;
}
