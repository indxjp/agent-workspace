/**
 * The engine catalogue this deployment offers (ADR-0065, ENG-02).
 *
 * An *engine* is the harness that turns an agent definition and a prompt into model calls, tool
 * calls and a stream of events. The control plane knows engines only through
 * `@indx-workspace/contracts/engines` — ids, capabilities and policy arms — and never imports an
 * adapter: which adapters a runtime image actually carries is the runner's business, and a
 * descriptor is `installed: false` when the catalogue knows an engine this deployment cannot run.
 *
 * Since ENG-07 (#306) that last sentence has a mechanism: `installed` is `./images.ts`'s configured
 * `engine → image` map, read for every registered engine alike. This module answers *which engines
 * the catalogue knows*; that one answers *which of them this deployment can start a sandbox for*.
 *
 * Every engine the catalogue (ADR-0136) lists is registered, in its order: the catalogue states the
 * display name and capabilities, this module adds the pinned SDK version.
 *
 * `GET /api/engines` is **not** here — it is #319. This module exists so the policy parser can ask
 * "is this engine registered?" (`unsupported_engine`) without waiting for that unit.
 */
import { z } from 'zod';

import {
  ENGINE_CATALOGUE,
  ENGINE_IDS,
  EngineCapabilitiesSchema,
  type EngineId,
} from '@indx-workspace/contracts/engines';

import { engineIsInstalled } from './images';

/**
 * The version of `@anthropic-ai/claude-agent-sdk` this platform is built against.
 *
 * Restated here rather than imported: `apps/web` must not depend on the runner's manifest, and the
 * control plane may not import the SDK at all (`tests/no-sdk-import.test.ts`). The restatement is
 * held to `apps/runner/package.json` by `registry.test.ts`, which reads the manifest — the same
 * "watched by a replay, not by a comment" rule as
 * `docs/adr/W2-CP-07-a-restatement-across-a-package-boundary-is-watched-by-a-replay-not-a-comment.md`.
 */
export const CLAUDE_AGENT_SDK_VERSION = '0.3.296';

/**
 * A descriptor as the *registry* holds one: the contract's {@link EngineDescriptor} with `id`
 * widened to `string` and **without** `installed`.
 *
 * The widening exists for exactly one caller, {@link registerEngineForTests}. A refusal that names
 * an unregistered engine cannot be proven while the only registered engine is the only engine the
 * contracts publish, so a test needs to register a descriptor whose id `ENGINE_IDS` does not list.
 * Every other field is validated by the contract's own schema, so a test descriptor is a real
 * descriptor in all but its id.
 *
 * `installed` is **not** a field of a registered engine since ENG-07 (#306). It is not a property of
 * the engine at all: it says whether *this deployment* can run it, which ADR-0073 answers from the
 * configured `engine to image` map and nothing else. A descriptor carrying its own `installed` would
 * be a second answer to that question, and the two would disagree exactly when it mattered - a
 * catalogue promising an engine the run route then refuses. {@link registeredEngines} derives it,
 * for every engine alike, from `./images.ts`.
 */
const RegisteredEngineSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    version: z.string().min(1),
    capabilities: EngineCapabilitiesSchema,
  })
  .strict()
  .readonly();

export type RegisteredEngine = z.infer<typeof RegisteredEngineSchema>;

/** A registered engine as a reader sees it: the descriptor plus this deployment's own answer. */
export type InstalledEngine = RegisteredEngine & Readonly<{ installed: boolean }>;

/**
 * The OpenAI Agents SDK version its adapter pins (ENG-09, #308). Restated for the reason
 * {@link CLAUDE_AGENT_SDK_VERSION} is; `registry.test.ts` reads the adapter's manifest.
 */
export const OPENAI_AGENTS_SDK_VERSION = '0.20.0';

/**
 * The pi coding agent version its adapter pins (ENG-08, #307). Restated for the reason
 * {@link CLAUDE_AGENT_SDK_VERSION} is; `registry.test.ts` reads the adapter's manifest.
 */
export const PI_CODING_AGENT_VERSION = '1.1.0';

/**
 * The Mastra release its adapter pins (ENG-10, #309). Restated for the reason
 * {@link CLAUDE_AGENT_SDK_VERSION} is; `registry.test.ts` reads the adapter's manifest.
 */
export const MASTRA_CORE_VERSION = '1.76.0';

/**
 * The SDK version each adapter pins, by engine. A build fact of the adapter's manifest, which is
 * why it is not in the engine catalogue (ADR-0136); `registry.test.ts` reads the manifests.
 */
const [claudeAgentSdk, openAiAgents, pi, mastra] = ENGINE_IDS;
const ENGINE_VERSIONS: Readonly<Record<EngineId, string>> = {
  [claudeAgentSdk]: CLAUDE_AGENT_SDK_VERSION,
  [openAiAgents]: OPENAI_AGENTS_SDK_VERSION,
  [pi]: PI_CODING_AGENT_VERSION,
  [mastra]: MASTRA_CORE_VERSION,
};

/** The built-in descriptors: the catalogue's name and capabilities plus the pinned version. */
const BUILT_IN_ENGINES: readonly RegisteredEngine[] = ENGINE_IDS.map((id) =>
  RegisteredEngineSchema.parse({
    id,
    displayName: ENGINE_CATALOGUE[id].displayName,
    version: ENGINE_VERSIONS[id],
    capabilities: ENGINE_CATALOGUE[id].capabilities,
  }),
);

interface GlobalEngineRegistry {
  __agentWorkspaceExtraEngines__?: readonly RegisteredEngine[];
}

const globalRegistry = globalThis as typeof globalThis & GlobalEngineRegistry;

/**
 * Every engine this deployment registers, `claude-agent-sdk` first.
 *
 * The order is the catalogue's, not a preference: a reader gets engines in the order `ENGINE_IDS`
 * declares them, with any test-only descriptor appended. A test-only descriptor whose id the
 * catalogue already holds **replaces** that entry in place rather than appearing beside it, so
 * every id appears exactly once and the order never depends on registration — see
 * {@link registerEngineForTests} for why replacement is the operation a capability refusal needs.
 */
export function registeredEngines(): readonly InstalledEngine[] {
  const registered: RegisteredEngine[] = [...BUILT_IN_ENGINES];
  for (const extra of globalRegistry.__agentWorkspaceExtraEngines__ ?? []) {
    const existing = registered.findIndex((engine) => engine.id === extra.id);
    if (existing === -1) registered.push(extra);
    else registered[existing] = extra;
  }
  // ENG-07 (#306): `installed` is the configured engine-image map and nothing else, for every
  // engine alike. See {@link RegisteredEngineSchema} for why no descriptor carries its own.
  return registered.map((engine) => ({ ...engine, installed: engineIsInstalled(engine.id) }));
}

/** The registered engine ids — the membership question the policy parser asks. */
export function registeredEngineIds(): readonly string[] {
  return registeredEngines().map((engine) => engine.id);
}

/** The descriptor for one id, or `null` when this deployment registers no such engine. */
export function registeredEngine(id: string): InstalledEngine | null {
  return registeredEngines().find((engine) => engine.id === id) ?? null;
}

/**
 * Register one more descriptor, for tests only. A descriptor whose id is already registered
 * replaces it.
 *
 * It is deliberately a *global* rather than an injected dependency, matching
 * `configureWebRuntimeRegistry`'s own shape, so a route test can install one without threading a
 * registry through every handler signature. The descriptor is validated on the way in, so a test
 * that registers a malformed engine fails here rather than producing a confusing refusal three
 * layers away.
 *
 * **Replacement, not only addition.** `AgentPolicy` has exactly one arm, so no policy body can
 * name an engine other than `claude-agent-sdk` and be parsed at all (`parsePolicyBody` answers
 * `invalid_policy` for a registered-but-unpublished engine). The only way a *save-time capability*
 * refusal can be reached, then, is a descriptor for `claude-agent-sdk` whose capabilities say `mcp:
 * false` or `skills: false` — a deployment that installs the engine but not what it needs. Adding
 * such a descriptor beside the built-in one would leave the built-in one answering first and the
 * refusal unreachable, which is the same "a refusal that cannot be reached is not proved" rule
 * `registered` on `parsePolicyBody` exists for.
 */
export function registerEngineForTests(descriptor: RegisteredEngine): void {
  const validated = RegisteredEngineSchema.parse(descriptor);
  globalRegistry.__agentWorkspaceExtraEngines__ = [
    ...(globalRegistry.__agentWorkspaceExtraEngines__ ?? []),
    validated,
  ];
}

/** Undo every {@link registerEngineForTests}. Call it in `afterEach`. */
export function clearEnginesRegisteredForTests(): void {
  delete globalRegistry.__agentWorkspaceExtraEngines__;
}
