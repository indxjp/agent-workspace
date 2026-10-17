/**
 * `packages/runtime/src/engine-images.ts` — the `engine → image` map (ENG-07, #306).
 *
 * ADR-0073: *"An image per engine. A deployment chooses which engines it offers by which images it
 * configures."* One runtime image carries the engine-neutral runner plus **exactly one** adapter,
 * and every driver that starts a container picks its image from this map using the run's engine.
 *
 * ## Why the map lives here rather than in `apps/web`
 *
 * Three processes need the same answer and none of them may derive it independently: the control
 * plane decides `installed` and refuses `engine_not_installed`, the runner manager starts the
 * container, and `packages/cli` writes the configuration both read. A second parser is a second
 * chance to disagree about what `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK` means — so the
 * parser is one function and the two applications call it.
 *
 * `packages/runtime` declares no dependencies (see `driver.ts`'s header), so this module cannot
 * import `ENGINE_IDS` from `@indx-workspace/contracts`. It does not restate it either: every
 * function that needs to know which ids exist takes them as a parameter, and the caller — which
 * *can* import the contracts — supplies them. A test in `apps/web` holds that hand-off to
 * `ENGINE_IDS`.
 *
 * ## What a refusal may say
 *
 * A malformed map fails parsing and the error names **keys only, never values** (ADR-0073 D5).
 * The startup error of a control plane is written to a log an operator reads over someone's
 * shoulder, and an image reference carries a registry host and often a project id; naming the key
 * is enough to fix the mistake, and naming the value is a leak with no upside. Every message below
 * is written to that rule and `engine-images.test.ts` asserts it by feeding the parser a distinctive
 * value and scanning the message for it.
 */

/**
 * The OCI label that says which engine an image carries, and the one that says at which versions.
 *
 * `io.agent-workspace.engine-version` is `<adapter>+<sdk>` — the adapter package's own version and
 * the third-party SDK it was built against — because both move independently and a support
 * question ("which Claude Agent SDK is in production?") is answerable from neither alone.
 *
 * Lean cannot prove what an image *contains*; that these labels describe the bytes is a declared
 * hypothesis of `formal/AgentWorkspace/Behaviour/EngineImages.lean`, enforced by the image build
 * rather than by a theorem. What the model does prove is that a driver never starts a run in an
 * image the map does not hold under that run's engine.
 */
export const ENGINE_IMAGE_LABEL = 'io.agent-workspace.engine';
export const ENGINE_IMAGE_VERSION_LABEL = 'io.agent-workspace.engine-version';

/**
 * The environment-variable prefix a deployment configures one engine's image under.
 *
 * `AGENT_WORKSPACE_RUNTIME_IMAGE_CLAUDE_AGENT_SDK`, `AGENT_WORKSPACE_RUNTIME_IMAGE_PI`. The
 * transform is total and reversible for every id this platform admits (see
 * {@link engineImageEnvName}), which is what lets a deployment be configured without a second list
 * of names to keep in step with `ENGINE_IDS`.
 */
export const ENGINE_IMAGE_ENV_PREFIX = 'AGENT_WORKSPACE_RUNTIME_IMAGE_';

/**
 * The pre-ENG-07 variable, still read as the `claude-agent-sdk` entry.
 *
 * A deployment upgraded in place has `RUNTIME_IMAGE` set and no per-engine variable; refusing to
 * start it would turn an additive change into an outage. The per-engine variable wins when both
 * are set, and `docs/deploy/engine-images.md` records the migration. It is deliberately **not** a
 * default for any other engine: "the image we happened to have" is exactly the wrong answer for an
 * engine whose adapter that image does not carry.
 */
export const LEGACY_RUNTIME_IMAGE_ENV = 'RUNTIME_IMAGE';

/** The map, keyed by engine id. Empty is legal and means "this deployment offers no engine". */
export type EngineImageMap = ReadonlyMap<string, string>;

/**
 * An engine id is exactly this shape: lower-case letters, digits and `-`, starting with a letter.
 *
 * A positive assertion rather than a list of rejected characters (ADR-0015). It is also what makes
 * {@link engineImageEnvName} reversible: `-` is the only character the transform rewrites, so
 * `claude-agent-sdk` and `claude_agent_sdk` cannot both exist and collide on one variable name.
 * ADR-0065's later ids (`acp:codex`) are not admitted here: an id carrying `:` has no environment
 * spelling, and the ADR that introduces one owns choosing it rather than this module guessing.
 */
const ENGINE_ID = /^[a-z][a-z0-9-]*$/u;

/**
 * An image reference, checked for shape rather than resolved.
 *
 * This is not a registry client and must not pretend to be one: what it refuses is a value that
 * cannot be an image reference at all — empty, whitespace-bearing, or carrying a character no
 * reference grammar admits — so a typo fails at startup rather than at the first run. Whether the
 * registry actually holds it is `Test Runtime`'s question (§14.9).
 */
const IMAGE_REFERENCE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[0-9]+)?(?:\/[A-Za-z0-9._-]+)*(?::[A-Za-z0-9._-]+)?(?:@sha256:[0-9a-f]{64})?$/u;

const DIGEST_PINNED = /@sha256:[0-9a-f]{64}$/u;

/**
 * A malformed `engine → image` map, as one error type.
 *
 * Its `keys` are the configuration keys at fault, so a caller can report all of them at once; its
 * `message` names those keys and **no value**. It is an `Error` subclass rather than a verdict
 * union because there is nothing to do with a malformed map except refuse to start: ADR-0015's
 * *"a check that cannot run must fail, not fall through"*.
 */
export class EngineImageConfigurationError extends Error {
  readonly keys: readonly string[];

  constructor(message: string, keys: readonly string[]) {
    super(message);
    this.name = 'EngineImageConfigurationError';
    this.keys = [...keys];
  }
}

/**
 * The environment-variable name one engine's image is configured under.
 *
 * Total for every id {@link ENGINE_ID} admits; throws by name for anything else, because a caller
 * that asked for the variable of an id this platform cannot spell has a bug rather than a
 * configuration problem.
 */
export function engineImageEnvName(engineId: string): string {
  if (typeof engineId !== 'string' || !ENGINE_ID.test(engineId)) {
    throw new EngineImageConfigurationError(
      `engineImageEnvName: ${JSON.stringify(engineId)} is not an engine id this platform can spell as an environment variable (must match ${String(ENGINE_ID)}).`,
      [],
    );
  }
  return `${ENGINE_IMAGE_ENV_PREFIX}${engineId.replace(/-/gu, '_').toUpperCase()}`;
}

/** What {@link parseEngineImageMap} needs beyond the entries themselves. */
export type EngineImageMapOptions = Readonly<{
  /**
   * Every engine id this deployment's catalogue publishes. A key outside it is refused rather than
   * ignored: a map naming `pie` instead of `pi` would otherwise start a control plane that reports
   * `pi` uninstalled and never says why.
   */
  knownEngineIds: readonly string[];
  /** Production deployments set this so a mutable tag cannot select a sandbox image. */
  requireDigest?: boolean;
  /** Names the configuration surface in a refusal: `'environment'`, `'images.runtime'`, … */
  source?: string;
}>;

function describeKeys(keys: readonly string[]): string {
  return keys.map((key) => JSON.stringify(key)).join(', ');
}

/**
 * Parse an `engine → image` map, or throw {@link EngineImageConfigurationError}.
 *
 * Total: either every entry names a published engine and a well-shaped reference and the map is
 * returned whole, or nothing is returned and the error names every key at fault. There is no
 * partial map — a control plane that dropped the one malformed entry would report that engine
 * `installed: false` and give an operator no way to tell a deliberate omission from a typo.
 *
 * The entries are an iterable of pairs rather than a record so a caller can hand over whatever
 * shape its own configuration has (an environment scan, a Helm value, a parsed JSON object)
 * without this function having to know about `__proto__`.
 */
export function parseEngineImageMap(
  entries: Iterable<readonly [string, string]>,
  options: EngineImageMapOptions,
): EngineImageMap {
  const source = options.source ?? 'configuration';
  const known = new Set(options.knownEngineIds);
  const map = new Map<string, string>();
  const unknownEngines: string[] = [];
  const malformedValues: string[] = [];
  const unpinnedValues: string[] = [];
  const duplicates: string[] = [];

  for (const [engineId, image] of entries) {
    if (map.has(engineId)) {
      duplicates.push(engineId);
      continue;
    }
    if (!ENGINE_ID.test(engineId) || !known.has(engineId)) {
      unknownEngines.push(engineId);
      continue;
    }
    if (typeof image !== 'string' || image.length === 0 || !IMAGE_REFERENCE.test(image)) {
      malformedValues.push(engineId);
      continue;
    }
    if (options.requireDigest === true && !DIGEST_PINNED.test(image)) {
      unpinnedValues.push(engineId);
      continue;
    }
    map.set(engineId, image);
  }

  const problems: string[] = [];
  if (unknownEngines.length > 0) {
    problems.push(
      `${describeKeys(unknownEngines)} name no engine this deployment publishes; the catalogue is @indx-workspace/contracts' ENGINE_IDS`,
    );
  }
  if (malformedValues.length > 0) {
    problems.push(
      `${describeKeys(malformedValues)} hold something that cannot be an image reference (the value is withheld from this message on purpose)`,
    );
  }
  if (unpinnedValues.length > 0) {
    problems.push(
      `${describeKeys(unpinnedValues)} are not pinned by sha256 digest, which this deployment requires`,
    );
  }
  if (duplicates.length > 0) {
    problems.push(`${describeKeys(duplicates)} are configured more than once`);
  }
  if (problems.length > 0) {
    throw new EngineImageConfigurationError(
      `engine runtime images: refusing to start because the ${source} is malformed: ${problems.join('; ')}.`,
      [...unknownEngines, ...malformedValues, ...unpinnedValues, ...duplicates],
    );
  }
  return map;
}

/**
 * Read the map out of a process environment.
 *
 * Only the variables whose engine id this deployment publishes are read, so an unrelated
 * `AGENT_WORKSPACE_RUNTIME_IMAGE_` variable left behind by an experiment cannot make a control
 * plane refuse to start — while a variable for a *published* engine that holds nonsense still
 * does. {@link LEGACY_RUNTIME_IMAGE_ENV} supplies `claude-agent-sdk` when its own variable is
 * absent (see that constant for why).
 */
export function readEngineImageMap(
  env: Readonly<Record<string, string | undefined>>,
  options: EngineImageMapOptions,
): EngineImageMap {
  const entries: (readonly [string, string])[] = [];
  for (const engineId of options.knownEngineIds) {
    const configured = env[engineImageEnvName(engineId)];
    const legacy = engineId === 'claude-agent-sdk' ? env[LEGACY_RUNTIME_IMAGE_ENV] : undefined;
    const value = configured ?? legacy;
    if (value === undefined || value.length === 0) continue;
    entries.push([engineId, value]);
  }
  return parseEngineImageMap(entries, { ...options, source: options.source ?? 'environment' });
}

/**
 * Refuse a map holding a mutable tag, at driver construction.
 *
 * The pre-ENG-07 `requireDigest` option of each driver, kept as a property of the whole map rather
 * than of one string: a production deployment that pinned `claude-agent-sdk` by digest and left
 * `pi` on `:latest` has pinned nothing that matters. Names the offending keys and no value, for the
 * reason {@link parseEngineImageMap} does.
 */
export function assertDigestPinnedEngineImages(images: EngineImageMap, driverId: string): void {
  const unpinned = [...images]
    .filter(([, image]) => !DIGEST_PINNED.test(image))
    .map(([engineId]) => engineId)
    .sort();
  if (unpinned.length > 0) {
    throw new EngineImageConfigurationError(
      `${driverId} runtime: production images must be pinned by sha256 digest; ${describeKeys(unpinned)} are not.`,
      unpinned,
    );
  }
}

/** Whether this deployment configured an image for `engineId` — ENG-02's `installed`. */
export function engineImageInstalled(images: EngineImageMap, engineId: string): boolean {
  return images.has(engineId);
}

/** The refusal an engine with no configured image answers, before any sandbox is created. */
export type EngineImageResolution =
  | Readonly<{ ok: true; image: string }>
  | Readonly<{ ok: false; code: 'engine_not_installed'; reason: string }>;

/**
 * Resolve the image one run must start in, or refuse.
 *
 * The refusal is a value rather than a throw because its caller is a route that answers `422` with
 * it (`apps/web/server/runs/api.ts`) and a driver that throws with its sentence
 * (`docker.ts`, `kubernetes.ts`, `cloud-run.ts`) — two different deliveries of one decision, which
 * is precisely the thing that must not be decided twice.
 *
 * The reason never names an image: it names the engine and the variable to set.
 */
export function resolveEngineImage(
  images: EngineImageMap,
  engineId: string,
): EngineImageResolution {
  const image = images.get(engineId);
  if (image === undefined) {
    const configured = [...images.keys()].sort();
    return {
      ok: false,
      code: 'engine_not_installed',
      reason:
        `this deployment configures no runtime image for engine ${JSON.stringify(engineId)}, so no sandbox can carry its adapter. ` +
        `Configured engines: ${configured.length === 0 ? '(none)' : configured.join(', ')}. ` +
        (ENGINE_ID.test(engineId)
          ? `Set ${engineImageEnvName(engineId)} to install it.`
          : 'That id has no environment spelling.'),
    };
  }
  return { ok: true, image };
}

/**
 * Resolve, or throw the refusal's own sentence.
 *
 * The shape every driver wants: a driver has nowhere to put a verdict, and starting a container in
 * an image chosen for a different engine is the one thing the dispatch invariant forbids.
 */
export function requireEngineImage(
  images: EngineImageMap,
  engineId: string,
  driverId: string,
): string {
  const resolved = resolveEngineImage(images, engineId);
  if (!resolved.ok) throw new Error(`${driverId} runtime: ${resolved.reason}`);
  return resolved.image;
}
