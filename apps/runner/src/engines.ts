/**
 * `apps/runner/src/engines.ts` — the runner's engine registry (ENG-04, #303).
 *
 * **This is the only file in `apps/runner` that names an engine adapter.** That is the whole
 * point of the unit and `dependency-cruiser.config.mjs` states it as a rule
 * (`runner-reaches-engine-adapters-only-through-engines-ts`): everything else in this
 * application talks to `@agent-workspace/engine`'s port, so adding an engine is adding a package
 * and a row below rather than editing a run path.
 *
 * ## Why the map is literal, and why the import is dynamic
 *
 * **Literal**, because `tests/no-sdk-import.test.ts` resolves every module reference with the
 * TypeScript compiler and refuses one it cannot read — ADR-0031's rule that an undecidable call
 * site is a refusal, never a skip. A specifier built from `request.engine` would be exactly that
 * refusal, so the engine id indexes a table of literal specifiers instead of being interpolated
 * into one. The issue's own "Known risks" names this; the table is the answer.
 *
 * **Dynamic**, because an engine a deployment did not install must be a *typed refusal at run
 * time* rather than a module-resolution failure at start-up. A runtime image built without the
 * Claude adapter — the `runtime.Dockerfile` variant ENG-07 will add, and the acceptance criterion
 * *"deleting `node_modules/@agent-workspace/engine-claude-agent-sdk` makes `/run` answer
 * `run-error {code:'engine_not_installed'}`"* — has to come up, serve `/healthz`, and say which
 * engines it has. A static `import` at the top of this file would make it fail to start instead,
 * which is the same information delivered as a crash.
 *
 * ## Why a load is cached, and what is cached
 *
 * The **outcome**, success or failure. A second `/run` for an engine this image does not carry
 * must answer as fast as the first and must not re-enter the module loader each time; and an
 * adapter that loaded once is one value for the life of the process, because an adapter is
 * stateless by the port's own definition (its state is the {@link EngineConnection} `start`
 * returns). Caching the failure as well as the success is ADR-0015's direction: an absent module
 * is a fact about this image, not a transient.
 *
 * ## Why no adapter is a production dependency of this application (ENG-09, #308)
 *
 * One runtime image carries exactly one adapter (ADR-0073 D1), so the runner cannot depend on
 * every adapter it can load: an `ENGINE=openai-agents` build does not copy the Claude adapter, and
 * a manifest naming it would fail `pnpm install` in that build. So `apps/runner/package.json`
 * names no adapter at all. In the workspace the specifiers below resolve through the root
 * manifest's development dependencies; in an image, `runtime.Dockerfile` links the one adapter it
 * built into this application's `node_modules`. The emit build type-checks these two imports
 * against `apps/runner/types/engine-modules.d.ts` — the export this table reads, typed `unknown` and
 * checked at run time by {@link readEngineExport} — so an image that did not copy an adapter still
 * compiles, and `engine_not_installed` is its honest answer (ADR-0074 "images").
 */
import type { RunRequest } from '@agent-workspace/core';
import type { AgentEngine, EngineRunRequest } from '@agent-workspace/engine';

/** One row of the registry: an engine id, and the literal specifier that loads its adapter. */
type EngineModuleLoader = () => Promise<unknown>;

/**
 * Every engine this runner build can carry, by id.
 *
 * One row per adapter package. The specifier is a literal for the reason the header gives, and
 * the value is a thunk so that nothing is loaded until a request names it.
 */
const ENGINE_MODULES: Readonly<Record<string, EngineModuleLoader>> = {
  'claude-agent-sdk': () => import('@agent-workspace/engine-claude-agent-sdk'),
  'openai-agents': () => import('@agent-workspace/engine-openai-agents'),
  pi: () => import('@agent-workspace/engine-pi'),
  mastra: () => import('@agent-workspace/engine-mastra'),
};

/**
 * Every engine this repository has an adapter package for, in id order (ENG-07, #306).
 *
 * The keys of {@link ENGINE_MODULES}, and therefore not a second list: an engine has a runtime
 * image exactly when it has an adapter to put in one, so this is the key set the runner manager
 * admits in its `engine → image` map. It is taken from the **real** table rather than from the
 * test-configurable one, because which engines can be built is a property of this repository and
 * not of whichever stub a suite installed.
 */
export const ADAPTER_ENGINE_IDS: readonly string[] = Object.keys(ENGINE_MODULES).sort();

/**
 * The export each adapter module publishes its {@link AgentEngine} under.
 *
 * A named export rather than a default, and checked rather than assumed: a module that resolved
 * but exported nothing shaped like an engine is a packaging mistake, and answering
 * `engine_not_installed` for it would be the wrong sentence — the package *is* installed, it is
 * the wrong version of it. {@link readEngineExport} says so by name.
 */
const ENGINE_EXPORTS: Readonly<Record<string, string>> = {
  'claude-agent-sdk': 'CLAUDE_AGENT_SDK_ENGINE_ADAPTER',
  'openai-agents': 'OPENAI_AGENTS_ENGINE_ADAPTER',
  pi: 'PI_ENGINE_ADAPTER',
  mastra: 'MASTRA_ENGINE_ADAPTER',
};

export type EngineLookup =
  | { readonly ok: true; readonly engine: AgentEngine }
  | {
      readonly ok: false;
      /** The code the `/run` refusal frame carries. See `packages/engine`'s `EngineRefusalCode`. */
      readonly code: 'engine_not_installed';
      readonly reason: string;
    };

/** Is this value an {@link AgentEngine}? Checked structurally; nothing here trusts a cast. */
function isAgentEngine(value: unknown): value is AgentEngine {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AgentEngine>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.version === 'string' &&
    typeof candidate.protectedConfigDirectory === 'string' &&
    typeof candidate.compile === 'function' &&
    typeof candidate.start === 'function' &&
    typeof candidate.capabilities === 'object' &&
    candidate.capabilities !== null
  );
}

function readEngineExport(id: string, module: unknown): EngineLookup {
  const name = ENGINE_EXPORTS[id];
  if (name === undefined) {
    return {
      ok: false,
      code: 'engine_not_installed',
      reason: `engine ${JSON.stringify(id)} has a module in this runner's registry but no declared export name; this is a packaging mistake in apps/runner/src/engines.ts.`,
    };
  }
  const exported =
    typeof module === 'object' && module !== null
      ? (module as Record<string, unknown>)[name]
      : undefined;
  if (!isAgentEngine(exported)) {
    return {
      ok: false,
      code: 'engine_not_installed',
      reason: `the adapter package for engine ${JSON.stringify(id)} loaded but its ${JSON.stringify(name)} export is not an AgentEngine. The package is installed at a version this runner cannot use.`,
    };
  }
  if (exported.id !== id) {
    return {
      ok: false,
      code: 'engine_not_installed',
      reason: `the adapter registered for engine ${JSON.stringify(id)} reports its own id as ${JSON.stringify(exported.id)}; refusing to run a request on an engine other than the one it named.`,
    };
  }
  return { ok: true, engine: exported };
}

/**
 * A resolver, so a test can prove the missing-adapter path without deleting a directory.
 *
 * The acceptance criterion this exists for is *"a test proves this with the registry's import
 * stubbed"*. `configureEngineModulesForTests` replaces the table; it is a function rather than an
 * exported mutable binding so the reset is explicit and a suite that forgets it fails loudly in
 * the next one rather than leaking a stub.
 */
let moduleTable: Readonly<Record<string, EngineModuleLoader>> = ENGINE_MODULES;
const cache = new Map<string, EngineLookup>();

/** Replace the registry's module table. Tests only; call {@link resetEngineModules} after. */
export function configureEngineModulesForTests(
  table: Readonly<Record<string, EngineModuleLoader>>,
): void {
  moduleTable = table;
  cache.clear();
}

/** Restore the real table and drop every cached load. */
export function resetEngineModules(): void {
  moduleTable = ENGINE_MODULES;
  cache.clear();
}

/**
 * Look one engine up, loading its adapter the first time it is asked for.
 *
 * Every failure arm answers `engine_not_installed` with a different sentence, and none of them
 * falls through to a default engine. Running a request on an engine other than the one it named
 * is the failure mode this registry exists to make impossible: the agent's tool policy, its
 * skills and its session were all composed for one engine, and quietly using another is a run
 * whose configuration means something different from what its author wrote.
 */
export async function loadEngine(id: string): Promise<EngineLookup> {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const loader = moduleTable[id];
  if (loader === undefined) {
    const known = Object.keys(moduleTable).sort();
    const result: EngineLookup = {
      ok: false,
      code: 'engine_not_installed',
      reason: `this runtime image carries no adapter for engine ${JSON.stringify(id)}. Installed: ${known.length === 0 ? '(none)' : known.join(', ')}.`,
    };
    cache.set(id, result);
    return result;
  }

  let module: unknown;
  try {
    module = await loader();
  } catch (error) {
    // The module is in the table and is not on disk — which is exactly the shape the acceptance
    // criterion describes, and exactly the shape a runtime image built without one adapter has.
    const failed: EngineLookup = {
      ok: false,
      code: 'engine_not_installed',
      reason: `the adapter package for engine ${JSON.stringify(id)} is declared by this runner but could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    };
    // An absent package is a fact about this image (ADR-0015) and is cached; any other failure may
    // be transient, and caching it would disable the engine until the runner restarts.
    if ((error as NodeJS.ErrnoException | null)?.code === 'ERR_MODULE_NOT_FOUND') {
      cache.set(id, failed);
    }
    return failed;
  }
  const result = readEngineExport(id, module);
  cache.set(id, result);
  return result;
}

/**
 * Translate a private-contract `RunRequest` into the port's neutral {@link EngineRunRequest}.
 *
 * Since ENG-04b (#325) this is a field-for-field forward and nothing else: the contract's v2 body
 * already carries the portable core and the engine-native arm separately, so there is no longer a
 * place where this application has to decide which half of `agent` was Claude's. `policy` crosses
 * **uninterpreted** — `unknown` in, `unknown` out — because the arm is addressed to an adapter and
 * this application is not allowed to know what is in it.
 *
 * The file bytes are deliberately **not** forwarded. `apps/runner/src/resources.ts` has already
 * written every granted file into the sandbox by the time a run starts, so handing the adapter a
 * second copy would be a megabyte of base64 travelling to a function that has nowhere to put it.
 * Skills *do* carry their bytes, because where a skill goes is the engine's decision
 * ({@link AgentEngine.placeSkills}) and the adapter is what makes it.
 */
export function toEngineRunRequest(request: RunRequest): EngineRunRequest {
  return {
    runId: request.runId,
    sessionId: request.sessionId,
    projectKey: request.projectKey,
    cwd: request.cwd,
    prompt: request.prompt,
    engine: request.engine,
    portable: request.portable,
    policy: request.policy,
    session:
      request.session.kind === 'resume'
        ? { mode: 'resume', engineSessionId: request.session.resume }
        : request.session.kind === 'fork'
          ? { mode: 'fork', engineSessionId: request.session.resume }
          : { mode: 'fresh' },
    gateway: request.gateway ?? null,
    resources: {
      files: (request.resources?.files ?? []).map((file) => ({
        kind: file.kind,
        path: file.path,
        access: file.access,
      })),
      skills: (request.resources?.skills ?? []).map((skill) => ({
        name: skill.name,
        files: skill.files.map((file) => ({
          path: file.path,
          contentBase64: file.contentBase64,
        })),
      })),
    },
    env: request.env,
  };
}

/** One installed engine, as `GET /healthz` reports it. */
export type InstalledEngineReport = {
  readonly id: string;
  readonly version: string;
  readonly protectedConfigDirectory: string;
};

/**
 * Which engines this image actually carries, with the version each adapter reports.
 *
 * This is what fills `EngineDescriptor.installed` / `version` in ENG-02's catalogue, so it is
 * deliberately the *result of loading each adapter* rather than a reading of the table: a row
 * whose package is missing is an engine this deployment knows about and cannot run, and
 * reporting it as installed because it is in a list would be the catalogue lying about the
 * runtime.
 *
 * Sorted by id so `/healthz` is stable output a human can diff.
 */
export async function installedEngines(): Promise<readonly InstalledEngineReport[]> {
  const reports: InstalledEngineReport[] = [];
  for (const id of Object.keys(moduleTable).sort()) {
    const lookup = await loadEngine(id);
    if (!lookup.ok) continue;
    reports.push({
      id: lookup.engine.id,
      version: lookup.engine.version,
      protectedConfigDirectory: lookup.engine.protectedConfigDirectory,
    });
  }
  return reports;
}
