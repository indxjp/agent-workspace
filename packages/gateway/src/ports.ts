/**
 * The database the gateway reads, as small ports: each adapter names only the members of
 * `DatabaseRoot` it uses (refactoring plan part 08, step 6). They are `Pick`s, so the production
 * root satisfies every one with no adapter code, and a change to the root breaks the build here
 * instead of drifting. `index.ts` opens the root; nothing else in the gateway names it.
 */
import type { DatabaseRoot } from '@agent-workspace/core/db';

/** A run token's run in its workspace: is the token live, and what is the run. */
export type GatewayRunTokens = Pick<DatabaseRoot, 'scopes' | 'runTokens' | 'runs'>;

/** Where settled usage is written, found from the run alone. */
export type GatewayUsageStore = Pick<DatabaseRoot, 'findRunWorkspace' | 'scopes' | 'runs'>;

/** What a run token resolves to: its run, its agent and its model connection. */
export type GatewayRunStore = Pick<
  DatabaseRoot,
  'scopes' | 'runTokens' | 'runs' | 'agents' | 'modelConnections'
>;

/** A workspace's spend over a window, and the run spend it adds to. */
export type GatewayDailyCostStore = Pick<DatabaseRoot, 'scopes' | 'runs'>;

/** A tool call's run and its connectors. */
export type GatewayToolStore = Pick<DatabaseRoot, 'scopes' | 'runTokens' | 'runs' | 'mcpServers'>;

/** One workspace's connectors, as the tool gateway reads them. */
export type GatewayConnectors = ReturnType<DatabaseRoot['mcpServers']['forScope']>;

/** One workspace's runs, as the tool gateway reads them. */
export type GatewayRuns = ReturnType<DatabaseRoot['runs']['forScope']>;
