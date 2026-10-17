/**
 * `apps/runner/src/runtime.test.ts` — drives {@link sessionScopedWorkspacePaths}, which round 1
 * shipped with zero tests and zero callers while two comments claimed otherwise
 * (`runtime.ts`'s own header and `docs/adr/W3-CP-09-session-scoped-workspace-paths.md`).
 *
 * The counter-example that found this: mutating `SAFE_PATH_SEGMENT` at `runtime.ts:214` from
 * `/^[A-Za-z0-9][A-Za-z0-9_-]*$/` to `/^.+$/`, rebuilding, and running the whole suite — every
 * test still passed, because nothing in the repository exercises this function. The identical
 * mutation applied to `packages/runtime/src/env.ts`'s copy IS caught by that package's own
 * `env.test.ts`. This file closes that gap on the runner side, with the same refusal list.
 *
 * `apps/runner` does not depend on `@agent-workspace/runtime` (see `runtime.ts`'s own header;
 * `apps/runner/package.json` is outside this task's `Owns` globs and this round may not touch any
 * `package.json`), so this file cannot import `packages/runtime/src/env.ts`'s
 * `sessionWorkspacePaths` to compare against directly. What it CAN do, and does, is drive this
 * copy against the exact list the sibling suite drives its copy against, so a future edit to
 * either regex without the other shows up as one suite's behaviour changing while the other's
 * does not — which is the whole point of having both, rather than one comment claiming the other
 * already covers this.
 */
import type { EngineRunRequest } from '@agent-workspace/engine';
import {
  createFakeSessionStore,
  createScriptedEngine,
  SCRIPTED_ENGINE_ID,
} from '@agent-workspace/engine/testing';
import { describe, expect, it } from 'vitest';

import { sessionScopedWorkspacePaths, startEngineAgent } from './runtime.js';

/**
 * The engine's own configuration directory, as the Claude adapter declares it.
 *
 * Written out here rather than imported from the adapter: this suite is about the path arithmetic,
 * and `sessionScopedWorkspacePaths` takes the directory as a parameter precisely so that it holds
 * for whatever an adapter answers (ENG-04b, #325).
 */
const CONFIG_DIRECTORY = '.claude';

describe('sessionScopedWorkspacePaths — §25 per-session cwd / CLAUDE_CONFIG_DIR, on the runner side', () => {
  it('two sessions under one workspace root get two distinct cwds and configDirs', () => {
    const a = sessionScopedWorkspacePaths('/workspace/agent-1', 'session-aaa', CONFIG_DIRECTORY);
    const b = sessionScopedWorkspacePaths('/workspace/agent-1', 'session-bbb', CONFIG_DIRECTORY);
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.configDir).not.toBe(b.configDir);
    expect(a.configDir.startsWith(a.cwd)).toBe(true);
    expect(b.configDir.startsWith(b.cwd)).toBe(true);
  });

  it("nests configDir as cwd/.claude, matching A.11's CLAUDE_CONFIG_DIR shape", () => {
    const { cwd, configDir } = sessionScopedWorkspacePaths(
      '/workspace/agent-1',
      'session-aaa',
      CONFIG_DIRECTORY,
    );
    expect(configDir).toBe(`${cwd}/.claude`);
  });

  it('trims a trailing slash on workspaceRoot before joining, so callers cannot double it up', () => {
    const withSlash = sessionScopedWorkspacePaths(
      '/workspace/agent-1/',
      'session-aaa',
      CONFIG_DIRECTORY,
    );
    const withoutSlash = sessionScopedWorkspacePaths(
      '/workspace/agent-1',
      'session-aaa',
      CONFIG_DIRECTORY,
    );
    expect(withSlash.cwd).toBe(withoutSlash.cwd);
  });

  // The exact refusal list this task's frozen finding named: a path-traversal, a bare `..`, two
  // absolute-path shapes (POSIX and Windows), an empty string, and two strings containing `/` or
  // a space — none of which `SAFE_PATH_SEGMENT` admits, so each must be refused BY NAME rather
  // than silently accepted into a directory name.
  it.each(['../escape', '..', '/etc/passwd', 'C:\\Windows', '', 'a/b', 'a b'])(
    'refuses sessionId %j as unsafe to use as a directory name',
    (bad) => {
      expect(() =>
        sessionScopedWorkspacePaths('/workspace/agent-1', bad, CONFIG_DIRECTORY),
      ).toThrow(/sessionScopedWorkspacePaths/);
    },
  );

  it('rejects an empty workspaceRoot by name', () => {
    expect(() => sessionScopedWorkspacePaths('', 'session-aaa', CONFIG_DIRECTORY)).toThrow(
      /workspaceRoot must be a non-empty string/,
    );
  });

  it('accepts a session id that is only digits, or only letters, or mixes in _ and -', () => {
    for (const ok of ['123', 'abc', 'session_123-final']) {
      expect(() =>
        sessionScopedWorkspacePaths('/workspace/agent-1', ok, CONFIG_DIRECTORY),
      ).not.toThrow();
    }
  });

  // The same four cases `packages/runtime/src/env.ts`'s `sessionWorkspacePaths` refuses
  // `protectedConfigDirectory` for: empty, a `/`-separated path, a `\`-separated path, and a bare
  // `..`. This copy gained the check later than its twin (round 2 of #325); driven here so a future
  // edit to either regex/condition without the other shows up as one suite's behaviour changing
  // while the other's does not.
  it.each(['', 'a/b', 'a\\b', '..'])(
    'refuses protectedConfigDirectory %j as not a single path segment',
    (bad) => {
      expect(() => sessionScopedWorkspacePaths('/workspace/agent-1', 'session-aaa', bad)).toThrow(
        /protectedConfigDirectory/,
      );
    },
  );
});

/**
 * ENG-06 (#305)'s durability criterion, proved with the **fake** engine.
 *
 * The claim is engine-neutral: *"a write failure of the store makes the run's `sessionDurability`
 * verdict non-durable for any engine."* The scripted adapter has no `mirror_error` concept and no
 * way to notice a rejected write — that is what makes it the right subject. If the verdict is still
 * `false`, it is `false` because the **store** said so, which is the only way the claim can hold for
 * an engine nobody has written yet.
 */
describe('startEngineAgent folds the store’s own failures into the durability verdict', () => {
  const request: EngineRunRequest = {
    runId: '33333333-4444-4555-8666-777777777777',
    sessionId: '11111111-2222-4333-8444-555555555555',
    projectKey: 'tenant-a',
    cwd: '/workspace/session',
    prompt: 'hello',
    engine: SCRIPTED_ENGINE_ID,
    portable: {
      name: 'Scripted',
      instructions: '',
      model: null,
      permissions: {
        readFiles: true,
        writeFiles: true,
        runCommands: true,
        unrestrictedNetwork: true,
      },
      skills: { mode: 'allowlist', names: [] },
      mcpServers: {},
      limits: { maxTurns: null, maxBudgetUsd: null },
    },
    policy: { kind: 'scripted' },
    session: { mode: 'fresh' },
    gateway: {
      baseUrl: 'https://gateway.example',
      token: 'run-token',
      protocol: 'anthropic-messages',
    },
    resources: { files: [], skills: [] },
    env: { PATH: '/usr/bin' },
  };

  async function verdictWith(behaviour: 'accept' | 'reject') {
    const store = createFakeSessionStore(behaviour);
    const outcome = startEngineAgent(createScriptedEngine(), request, { sessionStore: store });
    if (!outcome.ok) throw new Error(`the scripted engine refused the request: ${outcome.reason}`);
    for await (const frame of outcome.connection.frames) void frame;
    // The store's writes are asynchronous by construction; a verdict taken in the same tick would
    // be measuring the scheduler rather than the store.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    return { verdict: outcome.connection.sessionDurability(), store };
  }

  it('reports non-durable when the store rejected a write, naming how many', async () => {
    const { verdict, store } = await verdictWith('reject');
    expect(store.writeFailures().length).toBeGreaterThan(0);
    expect(verdict.durable).toBe(false);
    expect(verdict.durable ? '' : verdict.reason).toMatch(/session-store write\(s\) failed/);
  });

  it('leaves a clean run durable, so the fold can only ever make a verdict worse', async () => {
    const { verdict, store } = await verdictWith('accept');
    expect(store.writeFailures()).toEqual([]);
    expect(verdict.durable).toBe(true);
  });
});
