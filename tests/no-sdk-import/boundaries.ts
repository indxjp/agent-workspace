import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * **One row per confined SDK package** (ENG-04, #303): a third-party SDK, and the one file allowed
 * to import it.
 *
 * §42's claim ("SDK-specific translation is concentrated in one small module") is about **each**
 * SDK, so a second engine needs the same set equality, `.d.ts`-leak check and manifest check. A
 * table makes adding an engine add a row rather than relax a constant. Every field is read by an
 * assertion: `sdkPackage` / `boundaryFile` by the set equality, `emitProject` / `sourceRoot` /
 * `declarationFile` / `exportedSurface` by the `.d.ts` leak check (`exportedSurface` stops it
 * passing on an empty emit), `manifest` by the one-declaring-manifest assertion.
 */
export type EngineSdkBoundary = {
  /** For a failure message that names the adapter rather than a path. */
  readonly engine: string;
  /** Subpaths (`…/browser`, `…/bridge`) count as the same reference. */
  readonly sdkPackage: string;
  readonly boundaryFile: string;
  /**
   * The package's **build** view, not its type-checking view: `tsconfig.json` includes tests,
   * and a test importing the adapter's own modules is not part of the published surface this gate
   * is about.
   */
  readonly emitProject: string;
  /** The `rootDir` of that emit, so a declaration resolves from where its source lived. */
  readonly sourceRoot: string;
  readonly declarationFile: string;
  /** Names that must appear in the emitted declaration, so an empty emit cannot satisfy the check. */
  readonly exportedSurface: readonly string[];
  /** The one manifest allowed to declare {@link sdkPackage}. */
  readonly manifest: string;
};

function engineRow(
  engine: string,
  packageDir: string,
  sdkPackage: string,
  exportedSurface: readonly string[],
): EngineSdkBoundary {
  const root = `packages/${packageDir}`;
  return {
    engine,
    sdkPackage,
    boundaryFile: `${root}/src/boundary.ts`,
    emitProject: `${root}/tsconfig.build.json`,
    sourceRoot: `${root}/src`,
    declarationFile: 'boundary.d.ts',
    exportedSurface,
    manifest: `${root}/package.json`,
  };
}

const CLAUDE_SURFACE = ['startRun', 'toSdkOptions', 'SdkOptionOverlay', 'TranscriptMirror'];
const OPENAI_AGENTS_SURFACE = [
  'startOpenAiAgentsRun',
  'OpenAiAgentsRunStarter',
  'OPENAI_AGENTS_SDK_VERSION',
];
const PI_SURFACE = [
  'startPiRun',
  'PiRunStarter',
  'PiRunDeps',
  'PI_CODING_AGENT_VERSION',
  'installedPiDefaultAnthropicModel',
];
const MASTRA_SURFACE = [
  'startMastraRun',
  'MastraRunStarter',
  'MastraRunDeps',
  'MASTRA_CORE_VERSION',
  'MASTRA_PROCESS_ENVIRONMENT',
];

const claude = (pkg: string): EngineSdkBoundary =>
  engineRow('claude-agent-sdk', 'engine-claude-agent-sdk', pkg, CLAUDE_SURFACE);
const openAiAgents = (pkg: string): EngineSdkBoundary =>
  engineRow('openai-agents', 'engine-openai-agents', pkg, OPENAI_AGENTS_SURFACE);
const mastra = (pkg: string): EngineSdkBoundary =>
  engineRow('mastra', 'engine-mastra', pkg, MASTRA_SURFACE);

/**
 * The OpenAI Agents adapter confines three packages to **one** file (ENG-09, ADR-0074): the SDK,
 * the AI SDK bridge its Anthropic path needs, and the provider that bridge wraps. One row per
 * package, because each must be refused anywhere else; one boundary file, because a second
 * allow-listed file would be a second place for an SDK type to leak from. Mastra (ENG-10,
 * ADR-0084) is five packages behind one file the same way, and pi (ENG-08, ADR-0081) is one
 * package to the adapter. `@ai-sdk/anthropic` is confined once per adapter that uses it, because
 * the set equality is over files.
 */
export const ENGINE_SDK_BOUNDARIES: readonly EngineSdkBoundary[] = [
  claude('@anthropic-ai/claude-agent-sdk'),
  openAiAgents('@openai/agents'),
  openAiAgents('@openai/agents-extensions'),
  engineRow('pi', 'engine-pi', '@earendil-works/pi-coding-agent', PI_SURFACE),
  mastra('@mastra/core'),
  mastra('@mastra/mcp'),
  mastra('@mastra/memory'),
  mastra('@ai-sdk/anthropic'),
  mastra('@ai-sdk/openai'),
  openAiAgents('@ai-sdk/anthropic'),
];

export const SDK_PACKAGES: ReadonlySet<string> = new Set(
  ENGINE_SDK_BOUNDARIES.map((row) => row.sdkPackage),
);

/**
 * The one manifest that declares the confined SDKs without owning a boundary: the published
 * local-runtime bundle (ADR-0109).
 *
 * `@indx-workspace/embedded` inlines every engine adapter into one esbuild bundle and leaves each
 * SDK external, so its publish manifest, and the workspace manifest `node
 * packages/embedded/dist/launch.js` resolves from, must depend on them. Declaring is all it may
 * do: the import assertions still refuse any reference from it to an SDK, and the manifest test
 * holds the exception narrow (no importable API, SDKs only under `dependencies`, only at the
 * owning engine's exact pin).
 */
export const RUNTIME_BUNDLE_MANIFEST = 'packages/embedded/package.json';

export const SDK_BOUNDARY_FILES: readonly string[] = [
  // A set: one boundary file may confine more than one package (ADR-0074).
  ...new Set(ENGINE_SDK_BOUNDARIES.map((row) => row.boundaryFile)),
].sort((a, b) => a.localeCompare(b));

/**
 * The file a bare specifier that resolves nowhere is re-resolved from. A committed probe's
 * `@anthropic-ai/claude-agent-sdk` resolves to nothing in this tree, because its README tells a
 * reader to install the SDK in a scratch directory.
 */
export const SDK_BOUNDARY = ENGINE_SDK_BOUNDARIES[0]?.boundaryFile ?? '';

/** The TypeScript project whose presence proves the tree this gate scanned is the real one. */
export const BOUNDARY_PROJECT = 'packages/engine-claude-agent-sdk/tsconfig.json';

/**
 * One confined SDK, for the tests that exercise the **machinery** (walk, resolver, call-site
 * classifier) rather than the boundary. That machinery is shared by every row, so a copy per row
 * would assert the same code twice against a different string.
 */
export const SDK_PACKAGE = ENGINE_SDK_BOUNDARIES[0]?.sdkPackage ?? '';

/**
 * Where a research note's committed evidence lives. A probe is recognised by being at this path
 * with the shape of a probe, never by being named in a list
 * (`docs/adr/W2-INT-01-the-research-probe-permit-is-derived-by-shape.md`).
 */
export const RESEARCH_FIXTURE_ROOT = 'docs/research/fixtures';

export function isResearchFixture(file: string): boolean {
  return file.startsWith(`${RESEARCH_FIXTURE_ROOT}/`);
}

/**
 * A file that names the package in a comment and must never be detected as reaching it: the
 * negative control for the reference walk, which would otherwise pass by accident if it had
 * degenerated into "does the file contain the package name".
 */
export const PROSE_ONLY_CONTROL = 'packages/engine-claude-agent-sdk/src/compile.ts';

/**
 * Files decided to hold a dynamic import whose argument is computed, with the reason: the module
 * it names is chosen by the developer at run time and is never the SDK. Exact repository paths
 * only, never a glob; a test pins the list to exactly this entry (ADR-0115).
 */
export const COMPUTED_IMPORT_DECISIONS: ReadonlyMap<string, string> = new Map([
  [
    'packages/aw/src/tools/host-child.ts',
    "imports the developer's own run files by path; decided in ADR-0115",
  ],
]);

/**
 * Every package a committed fixture imports and this repository does not declare (ADR-0032
 * clause 1). The verdict is a *classification*, so what it classifies is written down and
 * compared as a set equality: a probe importing a new package fails the gate until the name is
 * added here and to the fixture's README, and a package that stops being imported fails it the
 * other way. A directory exclusion would produce neither failure.
 *
 * `@modelcontextprotocol/sdk` is here because `docs/research/fixtures/R-06-mcp/README.md` prints
 * the `npm install` line the R-06 probes run from; it is deliberately declared by no
 * `package.json` here, since a research note's evidence is not a dependency of this repository.
 */
export const PACKAGES_A_FIXTURE_INSTALLS_FOR_ITSELF = ['@modelcontextprotocol/sdk'];
