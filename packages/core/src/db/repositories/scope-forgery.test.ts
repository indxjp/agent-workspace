/**
 * The compile-time gate: **a repository cannot be constructed without a `WorkspaceScope`, and a
 * repository method cannot be handed a workspace id.**
 *
 * A property that is a compile error cannot be tested by code that compiles, so this block runs
 * the compiler. It writes a fixture whose every forgery sits on one line tagged `FORBIDDEN`, runs
 * `tsc` over it under the repository's own `tsconfig.json` — extended, not copied, so this gate
 * cannot drift from the settings the build uses — and then decides on positive assertions in both
 * directions:
 *
 *   * every `FORBIDDEN` line must carry at least one diagnostic, matched by line number, so one
 *     forgery being rejected cannot stand in for another;
 *   * every `PERMITTED` line must carry none, so the fixture cannot pass by being broken;
 *   * every `DECLARED` line must carry none either — those are the escapes `scope.ts` says it does
 *     not close at compile time, and asserting they still compile is what keeps that declaration
 *     from going stale;
 *   * a diagnostic on any *other* line fails the test rather than being ignored, because an
 *     unexpected error means the fixture is not compiling for the reason claimed.
 *
 * A non-zero exit code alone would satisfy none of that, which is why it is not what is asserted
 * (ADR-0015).
 *
 * The structure is lifted deliberately from `tests/auth.test.ts`, which is the gate W1-CP-06 built
 * for the *possession* half of the same rule. This is the *use* half. Two gates of one shape is
 * the point: an author adding the seventh Wave 2 repository copies a file they can already read.
 */
import path from 'node:path';

import { defineFixtureGate, repoRoot } from './scope-forgery.fixture-gate.test-support.js';

/**
 * `node_modules` because it is the one directory inside the repository that no `tsconfig.json`
 * includes, that ESLint ignores by default, that Prettier's globs do not reach and that git
 * ignores — so a fixture that must NOT type-check cannot break `pnpm typecheck`, `pnpm lint`,
 * `pnpm format:check` or a working tree several sessions are writing to, and a crashed run
 * leaves nothing tracked behind.
 */
const fixtureSource = [
  "import { createDatabaseAgentRepositoryProvider, createDatabaseWorkspaceScopeResolver } from '../../packages/core/src/db/repositories/unscoped.js';",
  "import { WorkspaceScope } from '../../packages/core/src/db/repositories/index.js';",
  "import type { AgentRepositoryProvider } from '../../packages/core/src/db/repositories/index.js';",
  "import type { Database } from '../../packages/core/src/db/client.js';",
  '',
  'declare const db: Database;',
  "const body = JSON.parse('{}') as { workspace: string; agentId: string };",
  'const agents: AgentRepositoryProvider = createDatabaseAgentRepositoryProvider(db);',
  '',
  '// Every shape a handler author could plausibly reach for, one per line.',
  'export const a = agents.forScope(body.workspace); // FORBIDDEN a workspace id string where the scope goes',
  'export const b = agents.forScope({ workspaceId: body.workspace }); // FORBIDDEN the scope written out as an object literal',
  'export const c = async () => agents.forScope({ ...(await legitimateScope()), workspaceId: body.workspace }); // FORBIDDEN a real scope spread and its tenant overwritten',
  'export const d = new WorkspaceScope(body.workspace); // FORBIDDEN the constructor called directly',
  'export const e = async () => agents.forScope(await legitimateScope()).list(body.workspace); // FORBIDDEN a workspace id handed to a read',
  'export const f = async () => agents.forScope(await legitimateScope()).get(body.agentId, body.workspace); // FORBIDDEN a workspace id handed alongside the row id',
  'export const g = async () => agents.forScope(await legitimateScope()).delete(body.agentId, body.workspace); // FORBIDDEN a workspace id handed to a write',
  '',
  '// Escapes this task did not close at compile time. Each is a declared gap in the PR body, and',
  '// each is asserted here to compile clean so the declaration cannot quietly go stale.',
  'export const h = agents.forScope(body.workspace as unknown as WorkspaceScope); // DECLARED a cast defeats every type in the program; refused at run time by requireWorkspaceScope, asserted below',
  'export const i = agents.forScope(Object.create(WorkspaceScope.prototype) as WorkspaceScope); // DECLARED the prototype conjured directly; refused at run time by requireWorkspaceScope, asserted below',
  'export const j = async (): Promise<WorkspaceScope> => Object.assign(await legitimateScope(), { workspaceId: body.workspace }); // DECLARED Object.assign onto a real scope: no diagnostic, and a TypeError at run time because the scope is frozen',
  'export const k = async () => createDatabaseWorkspaceScopeResolver(db).forWorkspaceId(body.workspace); // DECLARED a holder of the Database handle can resolve a scope for any workspace id; the public surface hands out no handle, and this import is the declared escape subpath',
  '',
  '// The one way that is meant to work, so a fixture that fails everywhere fails this test.',
  'export async function legitimateScope(): Promise<WorkspaceScope> {',
  "  const scope = await createDatabaseWorkspaceScopeResolver(db).forWorkspaceSlug('acme'); // PERMITTED the only derivation there is",
  "  if (scope === null) throw new Error('no such workspace');",
  '  return scope;',
  '}',
].join('\n');

defineFixtureGate({
  title: 'a repository cannot be built or queried without a WorkspaceScope (compile-time)',
  fixtureDir: path.join(repoRoot, 'node_modules', '.w2db02-type-negative'),
  fixtureName: 'forgery.ts',
  fixtureSource,
  testTitles: {
    inventory:
      'has forgeries to reject, a legitimate derivation to admit and declared gaps to record',
    forbidden: 'rejects the forgery on fixture line %i',
    permitted: 'admits the legitimate derivation on line %i',
  },
});
