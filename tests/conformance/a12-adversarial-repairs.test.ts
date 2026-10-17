/**
 * `tests/conformance/a12-adversarial-repairs.test.ts` — the round-2 AND round-3 repair rounds' own
 * counter-examples, committed rather than thrown away.
 *
 * The wave protocol's ADR-0046 check: *"does an implementation that does none of what this
 * scenario is about still pass? Build that implementation and run it."* Round 1 shipped four
 * scenarios (3, 7, 9, 10) that a driver doing none of what the scenario claimed to test could
 * still pass; B1-B4 below are round 2's counter-examples for those. Round 2's own repair then left
 * one shape unrepaired — the SAME four scenarios' `putFiles`/`getFiles` branch (3, 9) and an
 * environment-dependent scenario 10 (ADR-0047) — and introduced one new defect (a scenario 3 whose
 * in-sandbox read assumed a host-absolute path a correct container driver's sandbox never sees);
 * C1-C4 below are round 3's counter-examples for those four, one per frozen-list item. Each `it`
 * builds exactly the implementation ADR-0046/0047's question asks for and asserts the repaired
 * scenario now reports the correct verdict. Keeping these as real tests, not a throwaway probe
 * file, means a future regression on any of these scenarios is caught automatically rather than
 * depending on a verifier finding it a third or fourth time.
 */
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { runA12ConformanceSuite } from './harness.js';
import { decodeArchive, encodeArchive } from './fixtures/archive.js';
import {
  createFixtureStarter,
  fixtureAgentProbe,
  ENFORCED_NETWORK,
  SANDBOXED_FILE_ACCESS,
  SANDBOXED_FILE_WRITE,
} from './fixtures/common.js';
import type {
  FixtureFileAccess,
  FixtureFileWrite,
  FixtureEvent,
  FixtureRequest,
} from './fixtures/common.js';
import {
  CONTAINER_FIXTURE_CAPABILITIES,
  containerFixtureProbe,
  createContainerFixtureDriver,
} from './fixtures/container-fixture.js';
import { fileTransferFixtureProbe } from './fixtures/file-transfer-fixture.js';
import {
  createLocalFixtureDriver,
  LOCAL_RUNTIME_CAPABILITIES,
  localFixtureProbe,
} from './fixtures/local-fixture.js';
import type {
  A12AgentOutcome,
  A12Probe,
  RuntimeCapabilities,
  RuntimeDriver,
  RuntimeHandle,
} from './types.js';

describe('B1 (scenario 7): a driver that claims a ceiling but never enforces it must fail, not pass', () => {
  it('fails enforce-resource-limits when maxSessionSeconds is claimed but the starter has no enforcement wired', async () => {
    // Exactly PROBE 5's shape from round 1's verifier: a driver claiming `isolation: 'container'`
    // and a real, small `maxSessionSeconds`, whose fixture starter is plain `createFixtureStarter()`
    // — no `maxSessionSeconds` option, so the only thing that can ever stop a `'long-running'` turn
    // is an external `interrupt()` call, which this scenario must never make (ADR-0046 rule 2).
    const capabilities: RuntimeCapabilities = {
      ...CONTAINER_FIXTURE_CAPABILITIES,
      maxSessionSeconds: 1,
    };
    const startAgent = createFixtureStarter({
      network: ENFORCED_NETWORK,
      fileAccess: SANDBOXED_FILE_ACCESS,
      fileWrite: SANDBOXED_FILE_WRITE,
      // no maxSessionSeconds — the dishonest half of the fixture.
    });
    const live = new Map<string, RuntimeHandle>();
    const driver: RuntimeDriver<FixtureRequest, FixtureEvent> = {
      id: 'docker',
      capabilities,
      async create(config) {
        await mkdir(config.workspacePath, { recursive: true });
        const handle: RuntimeHandle = {
          id: randomUUID(),
          driver: 'docker',
          externalId: `never-enforces:${randomUUID()}`,
          workspacePath: config.workspacePath,
          createdAt: new Date(),
        };
        live.set(handle.id, handle);
        return handle;
      },
      async startAgent(runtime, request) {
        const known = live.get(runtime.id);
        if (known === undefined) throw new Error('handle not live');
        return await startAgent(known, request);
      },
      destroy(runtime) {
        live.delete(runtime.id);
        return Promise.resolve();
      },
    };

    const report = await runA12ConformanceSuite(driver, capabilities, containerFixtureProbe);
    const result = report.results.find((r) => r.id === 'enforce-resource-limits');

    console.log(
      `B1 counter-example verdict: ${String(result?.verdict)} — ${String(result?.detail)}`,
    );

    expect(result?.verdict).toBe('fail');
    expect(result?.detail).toMatch(/maxSessionSeconds/);
    expect(result?.detail).toMatch(/nothing enforced it/);
  }, 20_000);
});

describe('B2 + B3 (scenarios 9, 10, and 3): a probe that never reports readPath must fail every scenario that depends on it, not pass any of them', () => {
  it('fails hydrate-and-collect-files, concurrent-sessions-file-isolation and no-host-claude-config-visible when interpretEvents omits readPath, leaving every other scenario unaffected', async () => {
    // A probe identical to the shipped one except that it drops `readPath` from every outcome —
    // exactly round 1's verifier's PROBE 3. A driver that is otherwise fully honest (the real
    // container fixture, unmodified) must not be credited with scenarios whose adversarial or
    // cross-boundary check depends on a signal this probe never reports.
    const strippedProbe: A12Probe<FixtureRequest, FixtureEvent> = {
      agent: {
        buildRequest: (action) => fixtureAgentProbe.buildRequest(action),
        interpretEvents(events): A12AgentOutcome {
          const { readPath, ...stripped } = fixtureAgentProbe.interpretEvents(events);
          void readPath; // deliberately dropped — that is the whole point of this probe
          return stripped;
        },
      },
    };

    const driver = createContainerFixtureDriver();
    const report = await runA12ConformanceSuite(
      driver,
      CONTAINER_FIXTURE_CAPABILITIES,
      strippedProbe,
    );

    console.log(
      `B2+B3 counter-example report:\n${report.results
        .map((r) => `  ${r.verdict.padEnd(24)} ${r.id} — ${r.detail}`)
        .join('\n')}`,
    );

    const byId = Object.fromEntries(report.results.map((r) => [r.id, r]));

    for (const id of [
      'hydrate-and-collect-files',
      'concurrent-sessions-file-isolation',
      'no-host-claude-config-visible',
    ] as const) {
      expect(byId[id]?.verdict, `${id} should fail when readPath is never reported`).toBe('fail');
      expect(byId[id]?.detail).toMatch(/no result|never ran|never observed/);
    }

    // Scoped, not blanket: every scenario that does not depend on readPath is unaffected.
    const otherVerdicts = Object.fromEntries(
      report.results
        .filter(
          (r) =>
            r.id !== 'hydrate-and-collect-files' &&
            r.id !== 'concurrent-sessions-file-isolation' &&
            r.id !== 'no-host-claude-config-visible',
        )
        .map((r) => [r.id, r.verdict]),
    );
    expect(otherVerdicts).toEqual({
      'create-and-destroy': 'pass',
      'trivial-agent-turn': 'pass',
      'resume-after-sandbox-gone': 'pass',
      'enforce-network-none': 'pass',
      'enforce-network-restricted': 'pass',
      'enforce-resource-limits': 'pass',
      'interrupt-running-agent': 'pass',
    });
  }, 20_000);
});

describe('B4 (scenario 3): a driver that never runs an agent must not pass hydrate-and-collect-files', () => {
  it('fails hydrate-and-collect-files when startAgent unconditionally throws, on a driver claiming persistentFilesystem', async () => {
    // Exactly round 1's verifier's PROBE 4.
    const capabilities: RuntimeCapabilities = {
      ...CONTAINER_FIXTURE_CAPABILITIES,
      persistentFilesystem: true,
    };
    const live = new Map<string, RuntimeHandle>();
    const driver: RuntimeDriver<FixtureRequest, FixtureEvent> = {
      id: 'docker',
      capabilities,
      async create(config) {
        await mkdir(config.workspacePath, { recursive: true });
        const handle: RuntimeHandle = {
          id: randomUUID(),
          driver: 'docker',
          externalId: `never-runs:${randomUUID()}`,
          workspacePath: config.workspacePath,
          createdAt: new Date(),
        };
        live.set(handle.id, handle);
        return handle;
      },
      startAgent(): Promise<never> {
        throw new Error('this sandbox can never run an agent');
      },
      destroy(runtime) {
        live.delete(runtime.id);
        return Promise.resolve();
      },
    };

    const report = await runA12ConformanceSuite(driver, capabilities, containerFixtureProbe);
    const result = report.results.find((r) => r.id === 'hydrate-and-collect-files');

    console.log(
      `B4 counter-example verdict: ${String(result?.verdict)} — ${String(result?.detail)}`,
    );

    expect(result?.verdict).toBe('fail');
    expect(result?.detail).toMatch(/never run an agent/);
  }, 20_000);
});

describe('C1 (scenario 3): a driver whose startAgent can never run an agent must not pass hydrate-and-collect-files through the putFiles/getFiles branch either', () => {
  it('fails hydrate-and-collect-files when startAgent unconditionally throws, on a driver with putFiles/getFiles and no mounted filesystem', async () => {
    // B4's counter-example, one branch over — the frozen list's C1. Round 2 fixed the
    // `persistentFilesystem: true` branch but never touched this one: a driver with
    // `persistentFilesystem: false` whose `putFiles`/`getFiles` are a correct, per-handle
    // in-memory store never had `startAgent` called by the old scenario, so a driver whose
    // `startAgent` unconditionally throws still reported the round trip as `pass`.
    const capabilities: RuntimeCapabilities = {
      ...CONTAINER_FIXTURE_CAPABILITIES,
      persistentFilesystem: false,
    };
    const live = new Map<string, RuntimeHandle>();
    const stores = new Map<string, Map<string, string>>();
    const driver: RuntimeDriver<FixtureRequest, FixtureEvent> = {
      id: 'aws-agentcore',
      capabilities,
      async create(config) {
        await mkdir(config.workspacePath, { recursive: true });
        const handle: RuntimeHandle = {
          id: randomUUID(),
          driver: 'aws-agentcore',
          externalId: `c1-never-runs:${randomUUID()}`,
          workspacePath: config.workspacePath,
          createdAt: new Date(),
        };
        live.set(handle.id, handle);
        stores.set(handle.id, new Map());
        return handle;
      },
      startAgent(): Promise<never> {
        throw new Error('this sandbox can never run an agent');
      },
      destroy(runtime) {
        live.delete(runtime.id);
        stores.delete(runtime.id);
        return Promise.resolve();
      },
      async putFiles(runtime, archive) {
        const entries = await decodeArchive(archive);
        const store = stores.get(runtime.id) ?? new Map<string, string>();
        for (const entry of entries) store.set(entry.path, entry.content);
        stores.set(runtime.id, store);
      },
      getFiles(runtime, paths) {
        const store = stores.get(runtime.id) ?? new Map<string, string>();
        return Promise.resolve(
          encodeArchive(paths.map((p) => ({ path: p, content: store.get(p) ?? '' }))),
        );
      },
    };

    const report = await runA12ConformanceSuite(driver, capabilities, fileTransferFixtureProbe);
    const result = report.results.find((r) => r.id === 'hydrate-and-collect-files');

    console.log(
      `C1 counter-example verdict: ${String(result?.verdict)} — ${String(result?.detail)}`,
    );

    expect(result?.verdict).toBe('fail');
    expect(result?.detail).toMatch(/never run an agent/);
  }, 20_000);
});

describe("C2 (scenario 9): the putFiles/getFiles branch's adversarial cross-read must target something that branch actually writes to", () => {
  it("fails concurrent-sessions-file-isolation when a driver exposes every handle's store to any session's read-path action, regardless of which session is actually running", async () => {
    // The frozen list's C2. A driver on the putFiles/getFiles branch whose putFiles/getFiles ARE
    // correctly isolated per handle, but whose startAgent's read-path handling forgets the one
    // check that matters — whether `runtime` (the sandbox actually executing this request) is the
    // SAME handle the target names — has zero real session isolation despite claiming
    // `isolation: 'container'`. Round 2's cross-read (`path.join(handleB.workspacePath, ...)`)
    // could never have caught this: on this branch nothing is ever written under `workspacePath`,
    // so even THIS wide-open driver would have reported `succeeded: false` for the wrong reason.
    const capabilities: RuntimeCapabilities = {
      ...CONTAINER_FIXTURE_CAPABILITIES,
      persistentFilesystem: false,
    };
    const live = new Map<string, RuntimeHandle>();
    const stores = new Map<string, Map<string, string>>();
    const fileAccess: FixtureFileAccess = (_runtime, target) => {
      if (target.locus === 'host') return Promise.resolve({ succeeded: false });
      // BUG under test: resolves whatever handle `target` names, never checking it against the
      // handle `_runtime` (the sandbox actually running this request) actually is.
      const store = stores.get(target.handle.id);
      const content = store?.get(target.relativePath);
      return Promise.resolve(
        content === undefined ? { succeeded: false } : { succeeded: true, content },
      );
    };
    const fileWrite: FixtureFileWrite = (runtime, target, content) => {
      if (target.locus === 'host') return Promise.resolve({ succeeded: false });
      const store = stores.get(runtime.id) ?? new Map<string, string>();
      store.set(target.relativePath, content);
      stores.set(runtime.id, store);
      return Promise.resolve({ succeeded: true });
    };
    const startAgent = createFixtureStarter({ network: ENFORCED_NETWORK, fileAccess, fileWrite });
    const driver: RuntimeDriver<FixtureRequest, FixtureEvent> = {
      id: 'aws-agentcore',
      capabilities,
      async create(config) {
        await mkdir(config.workspacePath, { recursive: true });
        const handle: RuntimeHandle = {
          id: randomUUID(),
          driver: 'aws-agentcore',
          externalId: `c2-no-isolation:${randomUUID()}`,
          workspacePath: config.workspacePath,
          createdAt: new Date(),
        };
        live.set(handle.id, handle);
        stores.set(handle.id, new Map());
        return handle;
      },
      async startAgent(runtime, request) {
        const known = live.get(runtime.id);
        if (known === undefined) throw new Error('handle not live');
        return await startAgent(known, request);
      },
      destroy(runtime) {
        live.delete(runtime.id);
        stores.delete(runtime.id);
        return Promise.resolve();
      },
      async putFiles(runtime, archive) {
        const entries = await decodeArchive(archive);
        const store = stores.get(runtime.id) ?? new Map<string, string>();
        for (const entry of entries) store.set(entry.path, entry.content);
        stores.set(runtime.id, store);
      },
      getFiles(runtime, paths) {
        const store = stores.get(runtime.id) ?? new Map<string, string>();
        return Promise.resolve(
          encodeArchive(paths.map((p) => ({ path: p, content: store.get(p) ?? '' }))),
        );
      },
    };

    const report = await runA12ConformanceSuite(driver, capabilities, fileTransferFixtureProbe);
    const result = report.results.find((r) => r.id === 'concurrent-sessions-file-isolation');

    console.log(
      `C2 counter-example verdict: ${String(result?.verdict)} — ${String(result?.detail)}`,
    );

    expect(result?.verdict).toBe('fail');
    expect(result?.detail).toMatch(/could read session B's file/);
  }, 20_000);
});

describe("C3 (scenario 10): the check must fail on a clean machine — it never inherits its precondition from this host's real ~/.claude", () => {
  it('fails no-host-claude-config-visible against local even when HOME/USERPROFILE point at a fresh directory with no .claude at all', async () => {
    // ADR-0047's own acceptance test, verbatim: "`local` must fail scenario 10 on a machine with
    // no `~/.claude`." Round 2's version of this scenario asked `homedir()` directly, which is
    // exactly what this test defeats: point HOME/USERPROFILE at a directory this test just
    // created, with nothing under it, and confirm the scenario still fails against `local`
    // (isolation: 'none') — because round 3's version no longer asks about this host's incidental
    // state at all; it seeds and asks about its own marker instead.
    const emptyHome = await mkdtemp(path.join(tmpdir(), 'c3-empty-home-'));
    expect(existsSync(path.join(emptyHome, '.claude'))).toBe(false);
    const savedHome = process.env['HOME'];
    const savedUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = emptyHome;
    process.env['USERPROFILE'] = emptyHome;
    try {
      const driver = createLocalFixtureDriver();
      const report = await runA12ConformanceSuite(
        driver,
        LOCAL_RUNTIME_CAPABILITIES,
        localFixtureProbe,
      );
      const result = report.results.find((r) => r.id === 'no-host-claude-config-visible');

      console.log(
        `C3 counter-example (HOME=${emptyHome}, no .claude there) verdict: ${String(result?.verdict)} — ${String(result?.detail)}`,
      );

      expect(result?.verdict).toBe('fail');
      expect(result?.detail).toMatch(/readable from inside the sandbox/);
    } finally {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      if (savedUserProfile === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = savedUserProfile;
    }
  }, 20_000);
});

describe('C4 (scenario 3): a correct container driver whose in-sandbox mount differs from the host workspacePath must still pass hydrate-and-collect-files', () => {
  it('passes hydrate-and-collect-files against a driver that refuses every host-absolute read outright and only ever resolves a workspace-relative target itself', async () => {
    // The frozen list's C4 — PROBE E's shape, inverted to prove the repair rather than the defect.
    // A faithful container driver's sandbox never sees a host-absolute path at all (a bind mount is
    // visible by a DIFFERENT name inside the container), so a scenario that hands buildRequest a
    // pre-resolved host path can never be satisfied by such a driver, however correct its isolation
    // and its mount really are. This driver's fileAccess/fileWrite refuse every `'host'`-locus
    // target unconditionally — standing in for "a host-absolute path is meaningless to my sandbox"
    // — and only ever resolve a `'workspace'`-locus target, which round 3's scenario 3 now sends,
    // through their own translation (never a string the scenario pre-resolved for them).
    const capabilities: RuntimeCapabilities = {
      ...CONTAINER_FIXTURE_CAPABILITIES,
      persistentFilesystem: true,
    };
    const live = new Map<string, RuntimeHandle>();
    const resolveWorkspaceTarget = (
      runtime: RuntimeHandle,
      target: Extract<Parameters<FixtureFileAccess>[1], { locus: 'workspace' }>,
    ): string | null => {
      if (target.handle.id !== runtime.id) return null;
      const root = path.resolve(target.handle.workspacePath);
      const resolved = path.resolve(root, target.relativePath);
      return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
    };
    const fileAccess: FixtureFileAccess = async (runtime, target) => {
      if (target.locus === 'host') return { succeeded: false };
      const resolved = resolveWorkspaceTarget(runtime, target);
      if (resolved === null) return { succeeded: false };
      try {
        return { succeeded: true, content: await readFile(resolved, 'utf8') };
      } catch {
        return { succeeded: false };
      }
    };
    const fileWrite: FixtureFileWrite = async (runtime, target, content) => {
      if (target.locus === 'host') return { succeeded: false };
      const resolved = resolveWorkspaceTarget(runtime, target);
      if (resolved === null) return { succeeded: false };
      try {
        await mkdir(path.dirname(resolved), { recursive: true });
        await writeFile(resolved, content, 'utf8');
        return { succeeded: true };
      } catch {
        return { succeeded: false };
      }
    };
    const containmentHandle: RuntimeHandle = {
      id: 'c4-containment-a',
      driver: 'docker',
      externalId: 'c4-containment-a',
      workspacePath: path.join(tmpdir(), 'c4-containment', 'session-a'),
      createdAt: new Date(0),
    };
    const siblingFile = path.join(tmpdir(), 'c4-containment', 'session-b', 'mine.txt');
    const traversal = path.relative(containmentHandle.workspacePath, siblingFile);
    expect(
      resolveWorkspaceTarget(containmentHandle, {
        locus: 'workspace',
        handle: containmentHandle,
        relativePath: traversal,
      }),
    ).toBeNull();
    const startAgent = createFixtureStarter({ network: ENFORCED_NETWORK, fileAccess, fileWrite });
    const driver: RuntimeDriver<FixtureRequest, FixtureEvent> = {
      id: 'docker',
      capabilities,
      async create(config) {
        await mkdir(config.workspacePath, { recursive: true });
        const handle: RuntimeHandle = {
          id: randomUUID(),
          driver: 'docker',
          externalId: `c4-differing-mount:${randomUUID()}`,
          workspacePath: config.workspacePath,
          createdAt: new Date(),
        };
        live.set(handle.id, handle);
        return handle;
      },
      async startAgent(runtime, request) {
        const known = live.get(runtime.id);
        if (known === undefined) throw new Error('handle not live');
        return await startAgent(known, request);
      },
      destroy(runtime) {
        live.delete(runtime.id);
        return Promise.resolve();
      },
    };

    const report = await runA12ConformanceSuite(driver, capabilities, containerFixtureProbe);
    const result = report.results.find((r) => r.id === 'hydrate-and-collect-files');
    const isolationResult = report.results.find(
      (r) => r.id === 'concurrent-sessions-file-isolation',
    );

    console.log(
      `C4 counter-example verdict: ${String(result?.verdict)} — ${String(result?.detail)}`,
    );

    expect(result?.verdict).toBe('pass');
    expect(isolationResult?.verdict).toBe('pass');
  }, 20_000);
});
