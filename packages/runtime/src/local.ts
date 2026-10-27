/**
 * `packages/runtime/src/local.ts` — the `local` driver (spec §14.4).
 *
 * *"Development only. Runs the Agent SDK as a child process of the runner. Never advertise this
 * as tenant isolation. The UI must show a persistent warning when an agent is deployed on
 * `local`."*
 *
 * This is the simplest possible {@link RuntimeDriver}: there is no sandbox. `create()` makes a
 * directory, `startAgent()` hands the request to the starter the caller supplied, and
 * `destroy()` forgets the handle. Everything the agent does — every file it reads, every command
 * it runs, every host it reaches — it does as the runner process, on the runner's host, with the
 * runner's credentials.
 *
 * That is what {@link LOCAL_RUNTIME_CAPABILITIES} says, in the vocabulary §14.5 fixes, and it is
 * the whole reason this file leads with the capability record rather than the code. Beside it,
 * {@link LOCAL_CAPABILITY_BASIS} says *why* each of those answers is the answer, and
 * {@link auditCapabilityRecord} refuses the pair at import time if a field ever appears in one
 * and not the other.
 *
 * ## Why a starter is injected
 *
 * Spec §42: `apps/runner/src/claude.ts` is the only file in the repository that may import
 * `@anthropic-ai/claude-agent-sdk`. A driver that called `query()` itself would break that on its
 * first line. So the driver takes the "start an agent" function as an argument, and
 * `apps/runner/src/runtime.ts` — which sits on the right side of the §42 boundary — supplies the
 * SDK-backed one. The injection is the §42 boundary expressed as a parameter, not a design
 * flourish; every later driver is the same shape with a transport in the middle.
 */
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import type {
  AgentConnection,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeDriver,
  RuntimeHandle,
} from './driver.js';

/**
 * How the caller starts one agent inside a runtime this driver created.
 *
 * Returning `AgentConnection<TEvent> | Promise<…>` rather than only a promise is deliberate: the
 * in-process starter has nothing to await, and forcing it to be `async` would invent a
 * microtask's worth of asynchrony to satisfy a signature.
 */
export type AgentStarter<TRequest, TEvent> = (
  runtime: RuntimeHandle,
  request: TRequest,
) => AgentConnection<TEvent> | Promise<AgentConnection<TEvent>>;

/**
 * What `local` actually isolates, in the vocabulary of §14.5.
 *
 * Every field below is an answer this deployment will be believed on. **The reason each field
 * holds its value is not written here** — it is {@link LOCAL_CAPABILITY_BASIS}, one entry per
 * field, machine-readable, and checked against this record by {@link auditCapabilityRecord}
 * every time this module is imported. A prose comment beside a value is a claim nothing runs;
 * an entry in a record that a gate cross-checks is a claim that breaks when it stops being true.
 *
 * Two of the answers are the ones §14.4 forbids overstating, and both are answered down:
 * `isolation: 'none'` is §14.4's own word for this row, and `networkPolicies: ['open']` is a
 * single-element array because this driver has no mechanism to enforce `none` or `allowlist` —
 * §15.2 draws the consequence out, and the way the UI learns it is the length of this array.
 */
export const LOCAL_RUNTIME_CAPABILITIES: RuntimeCapabilities = {
  isolation: 'none',
  customImage: false,
  persistentFilesystem: true,
  sessionAffinity: true,
  maxSessionSeconds: null,
  networkPolicies: ['open'],
  execCommands: true,
  gpu: false,
  managedByProvider: false,
  typicalStartMs: 0,
  fileTransfer: 'local-disk',
};

/**
 * Why one capability field says what it says.
 *
 * Two arms, and the difference between them is the whole point of §14.5 and A.12:
 *
 * * `exercised` — a scenario was **run**, and it could have failed. `scenario` names it precisely
 *   enough that a reader can re-run it and get a verdict, not a reassurance.
 * * `structural` — no scenario is possible or needed, because the value follows from what this
 *   driver *is*: there is no image to pull, no provider to be managed by, one host. `reason` says
 *   which structural fact.
 *
 * There is deliberately no third arm for "seems right". A field with no basis does not compile
 * (the `Record<keyof RuntimeCapabilities, …>` below), and a basis with no field, or with a `kind`
 * this file does not recognise, is rejected at import time by {@link auditCapabilityRecord}.
 */
export type CapabilityBasis =
  | { readonly kind: 'exercised'; readonly scenario: string }
  | { readonly kind: 'structural'; readonly reason: string };

/**
 * The basis for each field of {@link LOCAL_RUNTIME_CAPABILITIES}.
 *
 * `Record<keyof RuntimeCapabilities, CapabilityBasis>` is what makes this exhaustive: a field
 * added to §14.5's type stops this file compiling until someone says why `local` answers it the
 * way it does. The run-time half of that guarantee — that no entry here names a field the record
 * does not have — is {@link auditCapabilityRecord}.
 */
export const LOCAL_CAPABILITY_BASIS: Readonly<Record<keyof RuntimeCapabilities, CapabilityBasis>> =
  {
    isolation: {
      kind: 'structural',
      reason:
        "§14.4's own word for this row. The agent is a child process of the runner, under the runner's uid, sharing the host kernel, filesystem and network namespace. There is no isolation to measure.",
    },
    customImage: {
      kind: 'structural',
      reason: 'There is no image. Nothing is pulled and nothing is built.',
    },
    persistentFilesystem: {
      kind: 'exercised',
      scenario:
        'A file written under `workspacePath` between `create()` and `destroy()` was read back after a second `create()`. `destroy()` deletes nothing, so the file is still there; a `destroy()` that removed the directory fails this.',
    },
    sessionAffinity: {
      kind: 'structural',
      reason:
        'There is one host: the runner process is the sandbox, so every request for a session necessarily reaches the instance that holds it. The driver contributes no mechanism — it parses `sessionId` and discards it, because §14.6 puts the `session → runtime handle` mapping in the control plane — so the caller supplies the workspace path and the single host supplies the affinity. Scoped to Simple Mode (§32); a replicated runner breaks it, and §14.4 already forbids `local` outside development for stronger reasons.',
    },
    maxSessionSeconds: {
      kind: 'structural',
      reason:
        'Nothing imposes a lifetime: no session product, no idle timer, no microVM budget. `null` is "no limit", not "unknown".',
    },
    networkPolicies: {
      kind: 'structural',
      reason:
        "This driver starts no proxy, writes no firewall rule and creates no namespace, so the agent's egress is exactly the host's and neither `none` nor `allowlist` can be enforced. §15.2: `none` here is not approximated, it is unavailable.",
    },
    execCommands: {
      kind: 'exercised',
      scenario:
        "A run through this driver, with `Bash` in the agent's tool surface, executed a shell command that wrote a harness-minted token, `hostname` and `whoami` to a file named by a *relative* path. The harness then read that file back from under the handle's `workspacePath` — which is what shows where the command ran — and the host and user it reported matched the runner process's own `os.hostname()` and `os.userInfo().username`. A run that could not execute a command, that ran it somewhere else, or that ran it as somebody else, fails this.",
    },
    gpu: {
      kind: 'structural',
      reason:
        'The host may have one; this driver neither requests, reserves nor guarantees it. A capability record answers for the driver, not for the machine.',
    },
    managedByProvider: { kind: 'structural', reason: 'There is no provider.' },
    typicalStartMs: {
      kind: 'structural',
      reason:
        'Not "fast" — *absent*. `create()` ensures a directory exists and starts no sandbox, so there is no start-up to time. `0` is the claim that nothing is started; `null` would be the claim that the driver cannot say, and it can.',
    },
    fileTransfer: {
      kind: 'structural',
      reason:
        'The runner shares the control plane host, so its workspace is a directory on the same disk: the archive is extracted there and nothing is pushed over the network.',
    },
  };

/** One row of {@link CapabilityAudit}: a field, the value it answers, and why. */
export type AuditedCapability = {
  readonly field: string;
  readonly value: unknown;
  readonly basis: CapabilityBasis;
};

/**
 * What {@link auditCapabilityRecord} returns when it accepts a record.
 *
 * `exercised` and `structural` partition `fields`. Nothing here is a count: a caller that wants
 * one takes the length of an array it can also print.
 */
export type CapabilityAudit = {
  readonly fields: readonly AuditedCapability[];
  readonly exercised: readonly string[];
  readonly structural: readonly string[];
};

/** The keys of a plain object, or a rejection describing what was passed instead. */
function keysOfObject(value: unknown, what: string): readonly string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`capability audit: ${what} must be a plain object; got ${describe(value)}.`);
  }
  return Object.keys(value);
}

/**
 * Check a capability record against its basis record, and refuse both if they have drifted.
 *
 * This is ADR-0015 applied to §14.5. It decides on positive assertions only:
 *
 *  1. Both arguments are plain objects — anything else is rejected by name.
 *  2. Every field of the capability record **has** a basis entry, and every basis entry **names**
 *     a field of the capability record. Both directions, because a one-way check passes a record
 *     that grew a field nobody justified.
 *  3. Every basis is one of the two arms of {@link CapabilityBasis}, carrying a non-empty
 *     sentence. The classifier ends in an explicit `else` that **rejects**: a `kind` this file
 *     does not recognise is not "probably fine", it is an unreviewed claim.
 *
 * It throws rather than returning a verdict object because there is no useful degraded mode: a
 * driver whose capability record and basis record disagree must not be exported at all, and
 * {@link LOCAL_CAPABILITY_AUDIT} runs this at module load so importing the package is what
 * enforces it.
 */
export function auditCapabilityRecord(
  capabilities: RuntimeCapabilities,
  basis: Readonly<Record<string, CapabilityBasis>>,
): CapabilityAudit {
  const capabilityFields = keysOfObject(capabilities, 'the capability record');
  const basisFields = keysOfObject(basis, 'the basis record');

  const unjustified = capabilityFields.filter((field) => !basisFields.includes(field));
  if (unjustified.length > 0) {
    throw new Error(
      `capability audit: ${unjustified.join(', ')} ${unjustified.length === 1 ? 'is a capability' : 'are capabilities'} with no recorded basis. §14.5 answers are believed; say why, or answer down.`,
    );
  }
  const orphaned = basisFields.filter((field) => !capabilityFields.includes(field));
  if (orphaned.length > 0) {
    throw new Error(
      `capability audit: ${orphaned.join(', ')} ${orphaned.length === 1 ? 'has a basis but is not' : 'have a basis but are not'} in the capability record.`,
    );
  }

  const record = capabilities as unknown as Record<string, unknown>;
  const fields: AuditedCapability[] = [];
  const exercised: string[] = [];
  const structural: string[] = [];
  for (const field of capabilityFields) {
    const entry = basis[field];
    if (entry === undefined) {
      // Unreachable given the two checks above; kept because `Record` lookups are typed as
      // present and this function must not depend on that being true at run time.
      throw new Error(`capability audit: ${field} has no recorded basis.`);
    }
    if (entry.kind === 'exercised') {
      if (typeof entry.scenario !== 'string' || entry.scenario.trim().length === 0) {
        throw new Error(
          `capability audit: ${field} claims a scenario was exercised but does not name it.`,
        );
      }
      exercised.push(field);
    } else if (entry.kind === 'structural') {
      if (typeof entry.reason !== 'string' || entry.reason.trim().length === 0) {
        throw new Error(
          `capability audit: ${field} claims a structural basis but does not say which fact.`,
        );
      }
      structural.push(field);
    } else {
      // The explicit else that rejects. `kind` is typed as a union of two literals, so reaching
      // here means the value came from somewhere the compiler did not check — a JSON row, a
      // hand-edited build output — and the one thing it must not do is fall through to accepted.
      const unrecognised: never = entry;
      throw new Error(
        `capability audit: ${field} carries a basis this driver does not recognise: ${JSON.stringify(unrecognised)}. A capability is exercised or it is structural; there is no third answer.`,
      );
    }
    fields.push({ field, value: record[field], basis: entry });
  }
  return { fields, exercised, structural };
}

/**
 * The audit of this driver's own record, evaluated at import.
 *
 * `env.test.ts` and `azure-lazy.test.ts` import this module (as do the conformance fixtures under
 * `tests/conformance/`), so this gate runs in CI on every build — which is the difference between
 * a rule an ADR states and a rule the repository keeps.
 */
export const LOCAL_CAPABILITY_AUDIT: CapabilityAudit = auditCapabilityRecord(
  LOCAL_RUNTIME_CAPABILITIES,
  LOCAL_CAPABILITY_BASIS,
);

/**
 * The persistent warning §14.4 requires, in the plain-language register of §14.5's examples.
 *
 * Exported as data so the control plane renders it rather than reinventing the wording, and so
 * that changing what the driver does forces a change to what the user is told, in one file.
 */
export const LOCAL_RUNTIME_WARNINGS: readonly string[] = [
  'This runtime provides no isolation. The agent runs as a process on the control-plane host, with the same user, filesystem and network access as the platform itself.',
  'This runtime cannot enforce a network policy. Egress is whatever the host can reach; "None" and "Restricted" are unavailable.',
  "Do not use this runtime for more than one tenant. Concurrent sessions share one filesystem and can read each other's workspaces.",
];

/** Name a value in a rejection message without stringifying something huge or cyclic. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  return `a value of type ${typeof value}`;
}

/**
 * Parse the config before anything is created (ADR-0015 rule 1).
 *
 * `RuntimeConfig` is a TypeScript type, which is a compile-time promise; this function is what
 * makes it true at run time, because the config reaches a driver from an HTTP body or a database
 * row on every driver that is not this one.
 */
function parseConfig(config: RuntimeConfig): RuntimeConfig {
  const problems: string[] = [];
  if (typeof config.sessionId !== 'string' || config.sessionId.length === 0) {
    problems.push(`sessionId must be a non-empty string; got ${describe(config.sessionId)}`);
  }
  if (typeof config.workspacePath !== 'string' || config.workspacePath.length === 0) {
    problems.push(
      `workspacePath must be a non-empty string; got ${describe(config.workspacePath)}`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`local runtime: refusing to create a runtime — ${problems.join('; ')}.`);
  }
  return config;
}

/**
 * The `local` driver.
 *
 * A factory rather than a singleton because the starter is an argument, and a closure rather
 * than a class because §39 rule 2 asks for one and there is no state worth a prototype: the
 * `live` map is the whole of it.
 */
export function createLocalDriver<TRequest, TEvent>(
  startAgent: AgentStarter<TRequest, TEvent>,
): RuntimeDriver<TRequest, TEvent> {
  /**
   * Handles this driver created and has not destroyed.
   *
   * It exists so `startAgent` and `destroy` can decide on a **positive** fact — "this handle is
   * one of mine and is still live" — instead of on the absence of a negative. A driver that
   * accepted any handle-shaped object would run an agent inside a workspace it never created,
   * and would report a successful `destroy()` for a runtime that was never there.
   */
  const live = new Map<string, RuntimeHandle>();

  function assertLive(runtime: RuntimeHandle, operation: string): RuntimeHandle {
    const id: unknown = runtime.id;
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `local runtime: cannot ${operation} — the handle has no id (${describe(id)}).`,
      );
    }
    const known = live.get(id);
    if (known === undefined) {
      throw new Error(
        `local runtime: cannot ${operation} — handle ${JSON.stringify(id)} was not created by this driver, or has already been destroyed.`,
      );
    }
    return known;
  }

  return {
    id: 'local',
    capabilities: LOCAL_RUNTIME_CAPABILITIES,

    async create(config: RuntimeConfig): Promise<RuntimeHandle> {
      const { sessionId, workspacePath } = parseConfig(config);
      // The only side effect there is. `recursive: true` is idempotent, so a second create() for
      // a workspace that already exists reuses it rather than failing — and, because it is
      // `mkdir` and not a fresh temp directory, reuses it without emptying it, which is what
      // `persistentFilesystem: true` is exercised against.
      await mkdir(workspacePath, { recursive: true });
      const handle: RuntimeHandle = {
        id: randomUUID(),
        driver: 'local',
        // There is no container, pod or task to name. The runner process is the sandbox, so the
        // honest external identity is the process itself; `expiresAt` is omitted because nothing
        // expires (maxSessionSeconds: null says the same thing to the UI).
        externalId: `pid:${String(process.pid)}`,
        workspacePath,
        createdAt: new Date(),
      };
      live.set(handle.id, handle);
      // `sessionId` is parsed and then deliberately not stored: §14.6 puts the
      // `session → runtime handle` mapping in the control plane, and a second copy here would be
      // a second answer. It is required in the config because a driver that cannot mount a
      // volume needs it, and the interface is one interface.
      //
      // This line is also why `sessionAffinity`'s basis is `structural` and not `exercised`: the
      // driver derives nothing from `sessionId`, so a check that passed the same `sessionId`
      // twice and compared the two `workspacePath`s would be comparing the caller's argument
      // with itself. The affinity is real, and it comes from there being one host.
      void sessionId;
      return handle;
    },

    async startAgent(runtime: RuntimeHandle, request: TRequest): Promise<AgentConnection<TEvent>> {
      const known = assertLive(runtime, 'start an agent');
      return await startAgent(known, request);
    },

    async destroy(runtime: RuntimeHandle): Promise<void> {
      const known = assertLive(runtime, 'destroy');
      // Nothing is torn down, and nothing is deleted. The workspace is a directory on the host
      // that the operator chose; §15.3 makes object storage the source of truth and the collect
      // step the way files leave a runtime, so a driver that removed the directory here would
      // destroy data the platform had not yet collected. Forgetting the handle is the whole of
      // destroy() for `local`, and persistentFilesystem: true is the capability record saying so.
      live.delete(known.id);
      return await Promise.resolve();
    },
  };
}
