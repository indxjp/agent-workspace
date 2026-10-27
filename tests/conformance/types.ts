/**
 * `tests/conformance/types.ts` — the shapes the A.12 harness (`tests/conformance/harness.ts`)
 * and its scenario table (`tests/conformance/scenarios.ts`) share.
 *
 * `RuntimeDriver`, `RuntimeHandle`, `RuntimeCapabilities` and `AgentConnection` are re-exported
 * from the package's declared root entrypoint. This keeps the conformance harness on the same
 * supported contract as production consumers and prevents tests from blessing internal modules.
 */
import type {
  AgentConnection,
  RuntimeCapabilities,
  RuntimeConfig,
  RuntimeDriver as ProductionRuntimeDriver,
  RuntimeHandle,
} from '@agent-workspace/runtime/driver';

export type { AgentConnection, RuntimeCapabilities, RuntimeConfig, RuntimeHandle };

/**
 * The production driver port plus the harness's own optional file-transfer pair.
 *
 * No production driver has `putFiles`/`getFiles` any more (files reach a driver through
 * `RuntimeCapabilities.fileTransfer`); scenarios 3 and 9 keep their second branch for fixture
 * drivers that hold content outside any mount, and only this type carries the pair.
 */
export type RuntimeDriver<TRequest, TEvent> = ProductionRuntimeDriver<TRequest, TEvent> & {
  putFiles?(runtime: RuntimeHandle, archive: ReadableStream): Promise<void>;
  getFiles?(runtime: RuntimeHandle, paths: string[]): Promise<ReadableStream>;
};

/**
 * The ten A.12 scenarios, stable internal identifiers.
 *
 * These are *our* identifiers, not spec text — `tests/conformance/scenarios.ts` carries the
 * verbatim spec line for each one in its `name` field, and
 * `tests/conformance/scenario-names.test.ts` is what proves those ten `name` values equal
 * A.12's ten lines, read out of `docs/spec.md` by `spec-scenarios.ts`. Nothing in the harness
 * itself branches on these ids by spec wording — they exist so a report and a test failure can
 * name a scenario shorter than its full sentence.
 */
export type A12ScenarioId =
  | 'create-and-destroy'
  | 'trivial-agent-turn'
  | 'hydrate-and-collect-files'
  | 'resume-after-sandbox-gone'
  | 'enforce-network-none'
  | 'enforce-network-restricted'
  | 'enforce-resource-limits'
  | 'interrupt-running-agent'
  | 'concurrent-sessions-file-isolation'
  | 'no-host-claude-config-visible';

/**
 * The three verdicts the wave plan's Accept line names, verbatim: *"pass / fail /
 * unsupported-by-capability"*.
 *
 * There is deliberately no fourth verdict. A.12's own rule — *"A driver that cannot pass a
 * scenario declares it unsupported in `RuntimeCapabilities`; it must never pass by weakening the
 * test"* — is enforced by `runA12ConformanceSuite` never attempting a scenario whose declared
 * capabilities do not claim it (that produces `unsupported-by-capability` without running
 * anything), and, when a scenario *is* attempted, reporting exactly what happened: `pass` if the
 * check the scenario defines actually held, `fail` otherwise. A scenario that fails while the
 * capability record claims support is still just `fail` — the hard-failure framing the plan's
 * Accept line describes is carried in `detail`, which names the capability field and what was
 * observed, and in `A12Report.dishonestCapabilityClaims`, which collects exactly those cases so a
 * caller does not have to re-derive "fail-while-claimed" by cross-referencing two lists by hand.
 */
export type A12Verdict = 'pass' | 'fail' | 'unsupported-by-capability';

/** One scenario's outcome against one driver. */
export type A12ScenarioResult = {
  readonly id: A12ScenarioId;
  /** The verbatim A.12 line this scenario implements. */
  readonly name: string;
  readonly verdict: A12Verdict;
  /**
   * Why. For `unsupported-by-capability`, names the capability field that does not claim support.
   * For `fail`, names both the capability claim (if any) that promised the scenario and what the
   * scenario actually observed — the "naming both" the wave plan's Accept line requires. For
   * `pass`, a short account of what was checked, so a report is legible without re-reading the
   * scenario's source.
   */
  readonly detail: string;
};

/** The whole report `runA12ConformanceSuite` returns for one driver run. */
export type A12Report = {
  readonly driverId: string;
  readonly results: readonly A12ScenarioResult[];
  /**
   * `true` iff no scenario's verdict is `fail`. `unsupported-by-capability` does not affect this —
   * an honestly declared gap is not a defect.
   */
  readonly ok: boolean;
  /**
   * Every scenario whose capability claim promised support and whose verdict was `fail` — the
   * exact set A.12's honesty rule calls a hard failure. Empty on an honest driver, `local`
   * included. Kept as a derived field rather than something a caller recomputes from `results`,
   * so "was anything dishonest" is one property read, not a re-implemented filter.
   */
  readonly dishonestCapabilityClaims: readonly A12ScenarioResult[];
};

/**
 * The one thing about "run an agent turn" that differs between drivers and cannot be decided by
 * this package: what a request object looks like, and how to read one back out of a stream of
 * events.
 *
 * `packages/runtime/src/driver.ts` makes `RuntimeDriver<TRequest, TEvent>` generic over exactly
 * this seam (its own header explains why: this package may not depend on `@agent-workspace/core`,
 * where the real `RunRequest`/`ClassifiedSdkEvent` types live). A driver-agnostic conformance
 * suite inherits the same seam rather than closing it by guessing a concrete shape — closing it
 * would make the harness usable against only whichever driver happens to share that guess, which
 * is a smaller thing than "driver-agnostic, executable against any driver." A caller wires this
 * once per driver: `tests/conformance/fixtures/*.ts` do it for `local` and for two harness-only
 * fixture drivers used to prove the harness itself, and a later task (W3-RT-03/W3-CP-07, per
 * the Wave 3 plan's 3a-2 row) does it again for `docker` with `apps/runner`'s real request
 * and event types when it runs this same exported function against that driver.
 */
/**
 * What a `'read-path'`/`'write-path'` action targets — see the C4 section of
 * `docs/adr/W3-QA-02-a12-conformance-harness-design.md` for why this exists as a variant rather
 * than a pre-resolved string.
 *
 * `'host'` names an arbitrary, already-absolute path on the machine — meaningful because it is a
 * fact about the HOST, not about anyone's workspace (scenario 10 asks whether a host location is
 * reachable from inside a sandbox; that is a host-absolute question by nature).
 *
 * `'workspace'` names a path *relative to one session's own workspace*, carrying that session's own
 * `RuntimeHandle` rather than a path the caller has already resolved. Resolving a `relativePath`
 * against a `handle` — to `path.join(handle.workspacePath, relativePath)` on a driver that mounts a
 * real host directory, to the driver's own internal per-handle store on one that does not, or to
 * whatever internal mount prefix a real container driver uses — is the PROBE's job (each
 * `A12AgentProbe`/fixture-starter's own `fileAccess`/`fileWrite`), never the scenario's: the
 * scenario does not and cannot know which of those a given driver actually is. A `handle` that
 * differs from the one the action's `startAgent` call is addressed to is exactly scenario 9's
 * adversarial case — "can THIS sandbox reach THAT session's workspace" — and is a request the
 * probe must be free to refuse outright, before ever resolving a path at all.
 */
export type A12PathTarget =
  | { readonly locus: 'host'; readonly absolutePath: string }
  | { readonly locus: 'workspace'; readonly handle: RuntimeHandle; readonly relativePath: string };

export type A12AgentAction =
  | { readonly kind: 'trivial'; readonly marker: string }
  | { readonly kind: 'resume'; readonly priorSessionId: string; readonly marker: string }
  | { readonly kind: 'long-running'; readonly marker: string }
  | {
      readonly kind: 'network-probe';
      readonly allowedHost: string;
      readonly blockedHost: string;
    }
  | { readonly kind: 'read-path'; readonly target: A12PathTarget }
  | { readonly kind: 'write-path'; readonly target: A12PathTarget; readonly content: string };

/** What a scenario can read back out of a finished (or interrupted) turn's events. */
export type A12AgentOutcome = {
  /** True when some event of the turn carries `marker`, verbatim, as the sandbox's own output. */
  readonly containsMarker: (marker: string) => boolean;
  /** True when the events record that the turn was interrupted before it completed on its own. */
  readonly wasInterrupted: boolean;
  /**
   * Present only for a `network-probe` action: whether the sandbox reported reaching the allowed
   * and the blocked host respectively.
   */
  readonly network?: { readonly allowedReachable: boolean; readonly blockedReachable: boolean };
  /** Present only for a `read-path` action: whether the sandbox could read `action.target`. */
  readonly readPath?: { readonly succeeded: boolean; readonly content?: string };
  /** Present only for a `write-path` action: whether the sandbox could create `action.target`. */
  readonly writePath?: { readonly succeeded: boolean };
  /**
   * The `CLAUDE_CONFIG_DIR` / `settingSources` this turn ran with, when the probe can report it —
   * present regardless of `action.kind`, since it describes the session's own configuration, not
   * something a specific action asked for. §14.7's two rules (a distinct config dir per session,
   * `settingSources: []` unless a workspace opts in) are what scenario 10 reads this against.
   */
  readonly config?: {
    readonly claudeConfigDir: string;
    readonly settingSources: readonly string[];
  };
};

/** The per-driver seam described above. */
export type A12AgentProbe<TRequest, TEvent> = {
  buildRequest(action: A12AgentAction): TRequest;
  interpretEvents(events: readonly TEvent[]): A12AgentOutcome;
};

/**
 * The seam for scenario 3 (`hydrate-and-collect-files`) on a driver whose `putFiles`/`getFiles`
 * are implemented (§15.3: drivers that cannot mount a volume use them instead). Optional on
 * {@link A12Probe} because a driver with `persistentFilesystem: true` and no volume-mount seam
 * needed (`local` today) never reaches it: the scenario writes to `RuntimeHandle.workspacePath`
 * directly in that case, exactly as `packages/runtime/src/local.ts`'s own
 * `persistentFilesystem` basis is exercised.
 *
 * `packages/runtime/src/driver.ts` types `putFiles`/`getFiles`'s archive as a bare
 * `ReadableStream` — a platform global, not a committed wire format — so this harness does not
 * assume tar. `tests/conformance/fixtures/file-transfer-fixture.ts` proves the branch with a
 * harness-only archive format it invents and reads back itself; the real POSIX ustar codec is
 * `packages/runtime/src/transfer.ts`, W3-CP-07's two levels below this one
 * (the Wave 3 plan's 3b-2 row), and out of this task's `tests/conformance/**` glob.
 */
export type A12FileTransferProbe = {
  /** Build a single-file archive whose one entry is named `path` and holds `content`. */
  buildArchive(entryPath: string, content: string): ReadableStream;
  /** Read a single-file archive back into its one entry's content, keyed by path. */
  readArchive(archive: ReadableStream): Promise<ReadonlyMap<string, string>>;
};

/** Everything a caller supplies alongside a driver and its claimed capabilities. */
export type A12Probe<TRequest, TEvent> = {
  readonly agent: A12AgentProbe<TRequest, TEvent>;
  readonly fileTransfer?: A12FileTransferProbe;
};
