/**
 * The §42 boundary gate (plan §9.1, `no-sdk-import test`).
 *
 * Spec §42: *"Keep all SDK-specific translation concentrated in one small module … For example:
 * `runner/src/claude.ts`"*, and the programme's constraint list states it as an absolute —
 * `apps/runner/src/claude.ts` is the only file in this repository that may reach
 * `@anthropic-ai/claude-agent-sdk`, and **a test enforces it**. This is that test. Five things
 * have to hold for that sentence to mean anything, and each is a separate assertion below:
 *
 *   1. the scan covers the **whole tracked tree**, and every file in it is *classified* — a file
 *      whose kind this gate does not recognise fails the gate rather than being skipped;
 *   2. every call site the scan walks past leaves with a **verdict**, and `new X(…)` is a call
 *      site. There are three verdicts and no fourth path: a reference whose specifier the gate
 *      read, a refusal naming the file and the construct, or the decision that a call handed no
 *      string this gate can read as a resolvable module is not naming one *here*. The third is a
 *      decision rather than a skip, and it carries the reach limits written out below — a
 *      specifier arriving through a parameter or out of a computation is inside it, and this
 *      clause does not claim otherwise;
 *   3. the set of files that reach the SDK is compared as a **set equality**, so the gate fails
 *      both when a new importer appears and when the expected one disappears;
 *   4. the boundary's **emitted declarations** name no SDK module, because an `import`-statement
 *      scan cannot see an SDK type that travels out on an exported signature in a `.d.ts`;
 *   5. the one other thing permitted to reach the SDK — a research note's committed probes — is
 *      **derived from the tracked tree by shape**, not named in a list here.
 *
 * ## A module specifier is not a string. It is an input to a resolution algorithm
 *
 * [ADR-0030](../docs/adr/0030-import-edges-are-resolved-by-the-compiler-not-matched-by-regex.md)
 * is the programme decision this file is written to, and
 * [W2-INT-01](../docs/adr/W2-INT-01-a-module-reference-is-resolved-not-compared.md) records what
 * it cost here. It is worth stating plainly, because six separate escapes were built against the
 * version that came before. That version captured the **raw source text** of a
 * specifier with a regular expression and answered "does this reach the SDK?" by comparing that
 * text — after expanding it through an alias table the gate maintained itself, out of
 * `compilerOptions.paths`, a manifest `imports` map and path dependencies.
 *
 * Every one of the six escapes is the same mistake wearing a different spelling. A `baseUrl` is a
 * resolution root that table did not model. A unicode escape in a specifier is the SDK's real
 * name to `tsc` and to node and a different string to a regular expression. A whitespace-free
 * `import'…'` is valid ESM that `\bimport\s+` cannot match. A package reached through the pnpm
 * symlink under `node_modules/` needs no configuration change at all.
 *
 * So this file does not decide where a reference points. It asks the compiler:
 *
 *   * **candidate references are found with the TypeScript AST** — `ts.createSourceFile` and a
 *     walk, not a pattern over raw text. The AST hands over the *cooked* specifier, so an escape
 *     is already decoded, and it has no opinion about whitespace;
 *   * **each reference is resolved with `ts.resolveModuleName`**, against the options of the
 *     nearest real `tsconfig.json`, parsed by `ts.getParsedCommandLineOfConfigFile` — so `paths`,
 *     `baseUrl`, `extends` of any filename, package `exports`/`imports` and symlinked workspace
 *     packages are the compiler's business, not this gate's;
 *   * **the answer is the resolved absolute path**, canonicalised through `realpathSync` so the
 *     pnpm store and the symlink into it are one place. Whether that path is the SDK is decided
 *     by walking up to its owning `package.json` and reading the `name` a resolver would read;
 *   * **a reference this gate cannot resolve fails the gate by name.** ADR-0015 on the one branch
 *     a resolver leaves open: a dynamic `import(variable)` and a specifier that resolves nowhere
 *     are both refusals, never skips;
 *   * **a failure prints the mapping, not just the file.** ADR-0030's consequence list asks for
 *     it: once the answer is a resolution, the interesting thing is that a specifier and the file
 *     it names need not look alike, so both set assertions print `file: specifier -> path` for
 *     every reference that put a file in the detected set.
 *
 * There is no alias table in this file. That is the point of the conversion: the table was a
 * model of a resolver, and the model was the bug.
 *
 * ## What this gate decides about a call site, and where its reach ends
 *
 * [ADR-0031](../docs/adr/0031-a-static-gate-cannot-be-complete-so-undecidable-must-mean-refused.md)
 * is the programme decision this section is written to, and
 * [W2-INT-01](../docs/adr/W2-INT-01-a-call-site-is-decided-by-what-it-is-handed.md) records what it
 * cost here. **A static gate over a dynamic language cannot be complete**, so the only honest thing
 * this file can do is say exactly what it decides and refuse the rest. What it decides:
 *
 *   * an `import`, `export … from`, `import type`, `import =` or `import()` — a syntactic module
 *     reference, whose specifier the parser hands over cooked;
 *   * **a call site is decided by what it is handed, not by what its callee is called.** Every
 *     call in the tree is examined. If a string this gate can read at that call site resolves to a
 *     module, and the gate cannot show the callee is something this file itself made, then the
 *     call is a **refusal that names the file and the construct** — never a pass. That is why
 *     `module.require('@anthropic-ai/claude-agent-sdk')` fails: not because the gate learned the
 *     name `module.require`, but because it does *not* know it. {@link RESOLVER_CALLS},
 *     {@link OPAQUE_CALLS} and {@link OPAQUE_PROPERTIES} are a fast path that produces a better
 *     message and, for a resolver, the specifier itself — a callee's absence from all three is not
 *     innocence.
 *   * **a construction is a call site.** `new X(…)` is examined by the same classifier, on the same
 *     question, because at least one constructor really does load a module: `new Worker(path)`
 *     starts a thread whose entry point node resolves and executes. `new` is not a shape this gate
 *     is allowed to decide by keyword — it is decided by what it is handed, like everything else.
 *   * **a reference resolved against an explicit base URL is read rather than refused.** A string
 *     handed to a call *together with* an absolute base URL — `import.meta.url`, or a literal URL —
 *     is the shape a URL resolution is written in, and the gate does that resolution instead of
 *     declining it. This is a collecting arm, not an exemption: the string is resolved like any
 *     other reference, so `new Worker(new URL('…/sdk.mjs', import.meta.url))` puts its file in the
 *     detected set. Two things about *how far* it reaches, both of them run rather than reasoned:
 *     it applies to **every** resolvable string handed to such a call and not just the first, so
 *     `Wibble('./package.json', 'file:///x/', '@anthropic-ai/claude-agent-sdk')` in a tracked file
 *     collects the SDK and fails the §42 set equality by name; and what it collects is decided by
 *     the *call* carrying a base URL, not by that string being the one resolved against it, so a
 *     string that no URL resolution would ever have been applied to is collected anyway. That
 *     second half is over-eagerness in the safe direction — a file this gate never loads can be
 *     counted as reached — and it is what keeps the arm from being a way past; the first half is
 *     the correction the patch after round 5 made, where stopping at the first collected string
 *     left the SDK at that same call site with no verdict at all.
 *
 * Where the reach ends, stated so that the next reader looks rather than trusts. Each of these is
 * asserted below, in `where this gate's reach ends`, as a demonstration rather than a claim:
 *
 *   * **`eval` and `new Function` are outside its reach.** A specifier built inside a string of
 *     source this gate never parses cannot be decided by any static analysis, so both are refused
 *     rather than analysed. An author willing to write `eval` is past this gate, and the refusal is
 *     the whole of the answer to that.
 *   * **A specifier this gate cannot read as a string at the call site is not seen.** A literal
 *     argument is read, and so is an identifier bound once by a `const` to a literal in the same
 *     file. A value that arrives as a function parameter, off an object, or out of a computation is
 *     not, so an unrecognised callee handed one of those is decided *not* to be a reference.
 *   * **Binding is by name over the whole file, not by scope.** A callee rooted at a name the file
 *     binds anywhere is treated as something the file made. A resolver smuggled in as a parameter
 *     is therefore not seen.
 *
 * ## Where the resolution happens from
 *
 * A reference is resolved from the file that writes it, which is what every resolver does. Two
 * further arms exist and each is narrow on purpose:
 *
 *   * a **relative** specifier TypeScript declines — `./globals.css` in `apps/web/app/layout.tsx`
 *     is the shape, an extension its resolver has no rule for — is joined onto the importing
 *     file's directory and accepted when that exact file exists. This is the definitional arm of
 *     relative resolution; it introduces no alias, and it can only ever name a file this
 *     repository already contains.
 *   * a **bare** specifier that resolves nowhere from its own file is resolved once more from
 *     {@link SDK_BOUNDARY}, a file inside the one package that declares the confined SDK. The
 *     committed probes are why: `docs/research/fixtures/agent-sdk/README.md` tells a reader to
 *     copy a probe out of the repository into a scratch directory, install the SDK there and run
 *     it under node — so a probe's `@anthropic-ai/claude-agent-sdk` resolves to nothing *in this
 *     tree*, while being a real SDK import in the environment the permit is about. This arm is
 *     over-eager and that is the safe direction: it can only ever add a file to the detected set.
 *
 * ## A package a fixture installs for itself is a classified verdict, not a refusal
 *
 * [ADR-0032](../docs/adr/0032-an-unresolvable-bare-specifier-inside-a-research-fixture-is-a-verdict-not-a-refusal.md)
 * is the programme decision this section is written to, and
 * [W2-INT-02](../docs/adr/W2-INT-02-a-fixture-runs-from-its-own-installation.md) records what it
 * cost here. The arm above resolves a fixture's bare specifier a second time from
 * {@link SDK_BOUNDARY}, and that reaches the one package this repository installs. It does not
 * reach the others. `docs/research/fixtures/R-06-mcp/README.md` tells a reader to run
 * `npm init -y && npm install @anthropic-ai/claude-agent-sdk@0.3.258 @modelcontextprotocol/sdk@1.30.0`
 * in a scratch directory and run the probes from *there* — so a probe's
 * `@modelcontextprotocol/sdk/client/stdio.js` is a real import in the environment the permit is
 * about and resolves to nothing in this tree, exactly as designed. Under the rule above that is a
 * refusal, and the refusal is correct **for the tree §42 protects** and wrong about the probe.
 *
 * So an unresolvable reference gets one of two verdicts, and the second is a *classification*
 * rather than an exemption. It is reached only when all three of these hold:
 *
 *   * the file writing it is under {@link RESEARCH_FIXTURE_ROOT}`/`;
 *   * the specifier is **bare** — it names a package. A relative or absolute specifier that
 *     resolves nowhere stays a hard failure here exactly as it is everywhere else, because a
 *     relative reference can only ever name a file this repository already contains, so one that
 *     resolves to nothing is a broken link and not an installation this tree does not have;
 *   * a `README.md` between the file and {@link RESEARCH_FIXTURE_ROOT}`/` **names that package**.
 *     This is the clause that keeps the verdict from becoming a hole: the permit rests on a human
 *     having written down where the package comes from, so a probe importing something no README
 *     mentions is refused by name and the message says which README to write it into.
 *
 * The set of packages this produces is **named and asserted** below, in `the §42 boundary gate can
 * actually run`, as a set equality against {@link PACKAGES_A_FIXTURE_INSTALLS_FOR_ITSELF}. It
 * therefore cannot grow silently: a tenth probe importing a tenth package fails the gate until
 * somebody adds the package to that list and to the README, which is the friction the classification
 * is for. It cannot shrink silently either, which is the ADR-0015 direction.
 *
 * Where this verdict's reach ends, stated rather than implied:
 *
 *   * **It says nothing about what the package does.** The gate never sees
 *     `@modelcontextprotocol/sdk`; it records that a fixture names a package this repository does
 *     not declare and that a README says where it comes from. Whether the installed package is the
 *     one the README names is outside every static analysis here.
 *   * **It rests on the fixture tree being imported by nothing.** That is not assumed — it is the
 *     `fixtureConsumers` assertion below, which is independent of resolvability and is what carries
 *     the safety. Read that one first if this verdict is ever widened.
 *   * **A README naming a package is prose matching, not a resolution.** The check is that the
 *     package name appears in the README as a name and not as a prefix of a longer one; nothing
 *     verifies the install line runs.
 *   * **`@anthropic-ai/claude-agent-sdk` never reaches this verdict today**, because it resolves
 *     through the confined-package arm above. If that arm ever stopped resolving, the SDK would
 *     arrive here as a package this repository does not declare — so the assertion below states
 *     that it is *not* in the classified set, and that is the control which catches it.
 *
 * ## Markup is a URL arm, not a module-specifier arm
 *
 * ADR-0030 binds the module-specifier question. A `src`/`href` in an HTML document is not a
 * module specifier: a browser resolves it as a **URL** against the document's URL, and there is
 * no `ts.resolveModuleName` for `https://cdn.example/…`. So markup references are resolved with
 * `new URL(reference, documentUrl)` — the algorithm a browser really uses — and then decided:
 * a `file:` URL by the same path comparison every other reference gets, and a remote URL by
 * whether its resolved *path* names the package, which is the only thing available for an origin
 * this gate cannot resolve against. That last comparison is the one place a name survives, and
 * the ADR declares it as a gap rather than hiding it.
 *
 * ## Names come from git, contents come from the working tree
 *
 * `trackedFiles()` asks `git ls-files` which files exist; `readTracked()` reads each one from the
 * working tree. Neither the index nor a commit is consulted, and that split is a decision, not an
 * accident:
 *
 *   * an uncommitted edit to a tracked file fails this gate while a person can still act on it,
 *     which is what a gate run from a developer's checkout is for;
 *   * a file that is not tracked is invisible to every assertion here, including one dropped
 *     under `docs/research/fixtures/`. That is the boundary being drawn on purpose: the §42
 *     permit is a statement about what this repository carries, and `git add` is what puts a file
 *     inside it. In CI the two agree, because the checkout is the commit.
 *
 * A file git lists that the working tree does not have throws rather than being skipped.
 *
 * ## It scans the repository, not a package
 *
 * The probe set is `git ls-files` — the tracked tree — for the reason
 * `docs/adr/W0-INF-02-probe-set-derived-from-the-tracked-tree.md` gives: a hand-written list of
 * directories is wrong the day someone adds one, and the gate that reads it goes quiet without
 * saying so. There is no directory exclusion anywhere in this file, **including for this file
 * itself**.
 *
 * One consequence of moving from a text scan to an AST walk is worth naming, because the previous
 * version of this file was written around its absence: a fixture below written as
 * `` `import { query } from '@anthropic-ai/claude-agent-sdk';` `` is a *string literal* in this
 * file's own syntax tree, and the walk collects module references, not strings. So the fixtures
 * are written out in full instead of assembled from joined fragments, and the §42 equality below
 * — which this file would fail if any of that were read as a reference — is what holds that
 * claim up.
 *
 * ## What "reaches the SDK" means, and why prose is not a hit
 *
 * Files in `packages/core` and `tests/` mention the package name in a comment, on purpose — they
 * exist because of the rule. A gate that grepped for the name would flag them, and the usual
 * repair is a directory exclusion, which is how a gate stops covering the tree it claims to
 * cover. A comment is not a module reference in a syntax tree, so the AST walk never sees one;
 * the negative control below asserts that on a file which really does carry the name in prose.
 *
 * ## Why the assertions are set equalities and not "no file outside the boundary"
 *
 * ADR-0015: a check that cannot run must fail, and a capability holds because a scenario passed.
 * A gate written as `expect(offenders).toEqual([])` passes just as happily when the scan found
 * nothing at all — a broken `git ls-files`, a renamed extension list, a walk that stopped
 * matching. Comparing the *whole* detected set against a named allowlist fails in both
 * directions: a new importer fails it, and so does the disappearance of the one importer that is
 * supposed to be there. The same reasoning is why the walk itself is exercised against a table of
 * import forms that must be recognised and a table that must be refused: a classifier with no
 * `else` that rejects is a gate that fails open.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isBuiltin } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * **One row per engine adapter** (ENG-04, #303): a third-party SDK, and the one file allowed to
 * import it.
 *
 * Until ENG-04 this was four loose constants, because there was one engine and one boundary file
 * and the two words meant the same thing. They do not: §42's claim is *"SDK-specific translation
 * is concentrated in one small module"*, which is a statement about **each** SDK, and a second
 * engine with a second SDK needs the same set equality, the same `.d.ts`-leak check and the same
 * manifest check applied to it. A table is what makes adding an engine add a row rather than
 * relax a constant — the failure mode this gate exists to prevent is exactly the one where a
 * second adapter is "obviously fine" and nothing checks it.
 *
 * Every field is here because an assertion below reads it:
 *
 *   * `sdkPackage` / `boundaryFile` — the set equality;
 *   * `emitProject` / `sourceRoot` / `declarationFile` / `exportedSurface` — the `.d.ts` leak
 *     check, which emits the package's declarations and reads them back. `exportedSurface` is
 *     what stops that check passing on an empty emit;
 *   * `manifest` — the assertion that exactly one manifest declares the SDK, so a second package
 *     quietly taking a dependency on it is a failure here rather than a discovery later.
 */
type EngineSdkBoundary = {
  /** The engine id, for a failure message that names the adapter rather than a path. */
  readonly engine: string;
  /** The package §42 confines. Subpaths (`…/browser`, `…/bridge`) count as the same reference. */
  readonly sdkPackage: string;
  /** The one file the specification allows to reach it. */
  readonly boundaryFile: string;
  /**
   * The project the declaration emit is driven from.
   *
   * The package's **build** view, not its type-checking view: a `tsconfig.json` includes tests,
   * and a test that legitimately imports the adapter's own modules is not part of the published
   * surface this gate is about. `tsconfig.build.json` excludes them and declares the `rootDir`
   * the emit is relative to.
   */
  readonly emitProject: string;
  /** The `rootDir` of that emit, so a declaration resolves from where its source lived. */
  readonly sourceRoot: string;
  /** The emitted declaration for {@link boundaryFile}. */
  readonly declarationFile: string;
  /** Names that must appear in that declaration, so an empty emit cannot satisfy the check. */
  readonly exportedSurface: readonly string[];
  /** The one manifest allowed to declare {@link sdkPackage}. */
  readonly manifest: string;
};

const ENGINE_SDK_BOUNDARIES: readonly EngineSdkBoundary[] = [
  {
    engine: 'claude-agent-sdk',
    sdkPackage: '@anthropic-ai/claude-agent-sdk',
    boundaryFile: 'packages/engine-claude-agent-sdk/src/boundary.ts',
    emitProject: 'packages/engine-claude-agent-sdk/tsconfig.build.json',
    sourceRoot: 'packages/engine-claude-agent-sdk/src',
    declarationFile: 'boundary.d.ts',
    exportedSurface: ['startRun', 'toSdkOptions', 'SdkOptionOverlay', 'TranscriptMirror'],
    manifest: 'packages/engine-claude-agent-sdk/package.json',
  },
  // ENG-09 (#308, ADR-0074): the OpenAI Agents adapter confines three packages to **one** file —
  // the SDK itself, the AI SDK bridge its Anthropic path needs, and the Anthropic provider that
  // bridge wraps. One row per package, because each is a package this gate must refuse anywhere
  // else; one boundary file, because a second allow-listed file would be a second place for an
  // SDK type to leak from.
  {
    engine: 'openai-agents',
    sdkPackage: '@openai/agents',
    boundaryFile: 'packages/engine-openai-agents/src/boundary.ts',
    emitProject: 'packages/engine-openai-agents/tsconfig.build.json',
    sourceRoot: 'packages/engine-openai-agents/src',
    declarationFile: 'boundary.d.ts',
    exportedSurface: [
      'startOpenAiAgentsRun',
      'OpenAiAgentsRunStarter',
      'OPENAI_AGENTS_SDK_VERSION',
    ],
    manifest: 'packages/engine-openai-agents/package.json',
  },
  {
    engine: 'openai-agents',
    sdkPackage: '@openai/agents-extensions',
    boundaryFile: 'packages/engine-openai-agents/src/boundary.ts',
    emitProject: 'packages/engine-openai-agents/tsconfig.build.json',
    sourceRoot: 'packages/engine-openai-agents/src',
    declarationFile: 'boundary.d.ts',
    exportedSurface: [
      'startOpenAiAgentsRun',
      'OpenAiAgentsRunStarter',
      'OPENAI_AGENTS_SDK_VERSION',
    ],
    manifest: 'packages/engine-openai-agents/package.json',
  },
  // ENG-08 (#307, ADR-0081): pi is one package to the adapter — `pi-ai` and `pi-agent-core` arrive
  // through it and are never imported directly — confined to the adapter's one boundary file.
  {
    engine: 'pi',
    sdkPackage: '@earendil-works/pi-coding-agent',
    boundaryFile: 'packages/engine-pi/src/boundary.ts',
    emitProject: 'packages/engine-pi/tsconfig.build.json',
    sourceRoot: 'packages/engine-pi/src',
    declarationFile: 'boundary.d.ts',
    exportedSurface: [
      'startPiRun',
      'PiRunStarter',
      'PiRunDeps',
      'PI_CODING_AGENT_VERSION',
      'installedPiDefaultAnthropicModel',
    ],
    manifest: 'packages/engine-pi/package.json',
  },
  // ENG-10 (#309, ADR-0084): Mastra is three packages to the adapter — the agent loop and
  // workspace (`@mastra/core`), the MCP client (`@mastra/mcp`) and `Memory` (`@mastra/memory`) —
  // plus the two AI SDK providers its model is built from. All five are confined to the adapter's
  // one boundary file. `@ai-sdk/anthropic` is therefore confined twice, to one boundary file per
  // adapter that uses it: the set equality below is over files, so each row names its own.
  {
    engine: 'mastra',
    sdkPackage: '@mastra/core',
    boundaryFile: 'packages/engine-mastra/src/boundary.ts',
    emitProject: 'packages/engine-mastra/tsconfig.build.json',
    sourceRoot: 'packages/engine-mastra/src',
    declarationFile: 'boundary.d.ts',
    exportedSurface: [
      'startMastraRun',
      'MastraRunStarter',
      'MastraRunDeps',
      'MASTRA_CORE_VERSION',
      'MASTRA_PROCESS_ENVIRONMENT',
    ],
    manifest: 'packages/engine-mastra/package.json',
  },
  {
    engine: 'mastra',
    sdkPackage: '@mastra/mcp',
    boundaryFile: 'packages/engine-mastra/src/boundary.ts',
    emitProject: 'packages/engine-mastra/tsconfig.build.json',
    sourceRoot: 'packages/engine-mastra/src',
    declarationFile: 'boundary.d.ts',
    exportedSurface: [
      'startMastraRun',
      'MastraRunStarter',
      'MastraRunDeps',
      'MASTRA_CORE_VERSION',
      'MASTRA_PROCESS_ENVIRONMENT',
    ],
    manifest: 'packages/engine-mastra/package.json',
  },
  {
    engine: 'mastra',
    sdkPackage: '@mastra/memory',
    boundaryFile: 'packages/engine-mastra/src/boundary.ts',
    emitProject: 'packages/engine-mastra/tsconfig.build.json',
    sourceRoot: 'packages/engine-mastra/src',
    declarationFile: 'boundary.d.ts',
    exportedSurface: [
      'startMastraRun',
      'MastraRunStarter',
      'MastraRunDeps',
      'MASTRA_CORE_VERSION',
      'MASTRA_PROCESS_ENVIRONMENT',
    ],
    manifest: 'packages/engine-mastra/package.json',
  },
  {
    engine: 'mastra',
    sdkPackage: '@ai-sdk/anthropic',
    boundaryFile: 'packages/engine-mastra/src/boundary.ts',
    emitProject: 'packages/engine-mastra/tsconfig.build.json',
    sourceRoot: 'packages/engine-mastra/src',
    declarationFile: 'boundary.d.ts',
    exportedSurface: [
      'startMastraRun',
      'MastraRunStarter',
      'MastraRunDeps',
      'MASTRA_CORE_VERSION',
      'MASTRA_PROCESS_ENVIRONMENT',
    ],
    manifest: 'packages/engine-mastra/package.json',
  },
  {
    engine: 'mastra',
    sdkPackage: '@ai-sdk/openai',
    boundaryFile: 'packages/engine-mastra/src/boundary.ts',
    emitProject: 'packages/engine-mastra/tsconfig.build.json',
    sourceRoot: 'packages/engine-mastra/src',
    declarationFile: 'boundary.d.ts',
    exportedSurface: [
      'startMastraRun',
      'MastraRunStarter',
      'MastraRunDeps',
      'MASTRA_CORE_VERSION',
      'MASTRA_PROCESS_ENVIRONMENT',
    ],
    manifest: 'packages/engine-mastra/package.json',
  },
  {
    engine: 'openai-agents',
    sdkPackage: '@ai-sdk/anthropic',
    boundaryFile: 'packages/engine-openai-agents/src/boundary.ts',
    emitProject: 'packages/engine-openai-agents/tsconfig.build.json',
    sourceRoot: 'packages/engine-openai-agents/src',
    declarationFile: 'boundary.d.ts',
    exportedSurface: [
      'startOpenAiAgentsRun',
      'OpenAiAgentsRunStarter',
      'OPENAI_AGENTS_SDK_VERSION',
    ],
    manifest: 'packages/engine-openai-agents/package.json',
  },
];

/** Every confined SDK, as a set — the membership question `sdkOwns` asks. */
const SDK_PACKAGES: ReadonlySet<string> = new Set(
  ENGINE_SDK_BOUNDARIES.map((row) => row.sdkPackage),
);

/**
 * The one manifest that declares the confined SDKs without owning a boundary: the published
 * local-runtime bundle (ADR-0109).
 *
 * `@indx-workspace/embedded` inlines every engine adapter into one esbuild bundle and leaves each
 * SDK external, so its generated publish manifest must depend on them — and, because ESM links an
 * external `import` before any code runs, so must the workspace manifest the in-repo
 * `node packages/embedded/dist/launch.js` resolves them from. Declaring is all it may do. The
 * import assertions still refuse any reference from `packages/embedded` to an SDK, and the test
 * "is declared by the runtime bundle only as the owning engine pins it" holds this exception
 * narrow: the manifest is `@indx-workspace/embedded`, exports only `./launch` and `./package.json`
 * (no importable API that could re-export an SDK), declares each SDK only under `dependencies`,
 * and only at exactly the version its owning engine manifest pins, so it can never introduce or
 * move an SDK. The package publishes (S1-12, issue #450) from the generated staging manifest
 * `packages/embedded/publish/package.json`, whose SDK entries are the same installed versions.
 */
const RUNTIME_BUNDLE_MANIFEST = 'packages/embedded/package.json';

/** Every permitted boundary file, sorted, for the set equality and its failure message. */
const SDK_BOUNDARY_FILES: readonly string[] = [
  // A set: one boundary file may confine more than one package (ADR-0074).
  ...new Set(ENGINE_SDK_BOUNDARIES.map((row) => row.boundaryFile)),
].sort((a, b) => a.localeCompare(b));

/**
 * The file a bare specifier that resolves nowhere is re-resolved from.
 *
 * See the header's "Where the resolution happens from": a committed probe's
 * `@anthropic-ai/claude-agent-sdk` resolves to nothing in this tree, because the README tells a
 * reader to install it in a scratch directory. Every boundary file is tried in turn, so the arm
 * keeps working when a second adapter is the one that declares the package a probe imports.
 */
const SDK_BOUNDARY = ENGINE_SDK_BOUNDARIES[0]?.boundaryFile ?? '';

/** The TypeScript project whose presence proves the tree this gate scanned is the real one. */
const BOUNDARY_PROJECT = 'packages/engine-claude-agent-sdk/tsconfig.json';

/**
 * One confined SDK, for the tests that exercise the **machinery** rather than the boundary.
 *
 * The walk, the resolver and the call-site classifier are one implementation shared by every
 * row, so the tests that drive them need a package name that really resolves and do not need one
 * per row — a second copy of each would assert the same code twice against a different string.
 * The tests about the *boundary* iterate {@link ENGINE_SDK_BOUNDARIES}; these do not, and that
 * distinction is why this constant still exists.
 */
const SDK_PACKAGE = ENGINE_SDK_BOUNDARIES[0]?.sdkPackage ?? '';

/**
 * Where a research note's committed evidence lives.
 *
 * A probe is recognised by **being at this path with the shape of a probe**, never by being
 * named in this file. See section 1a below and
 * `docs/adr/W2-INT-01-the-research-probe-permit-is-derived-by-shape.md`.
 */
const RESEARCH_FIXTURE_ROOT = 'docs/research/fixtures';

/** Is this tracked path inside the research-fixture tree? */
function isResearchFixture(file: string): boolean {
  return file.startsWith(`${RESEARCH_FIXTURE_ROOT}/`);
}

/**
 * A file that names the package in a comment and must never be detected as reaching it.
 *
 * The negative control for the reference walk. Without it, a walk that had degenerated into
 * "does this file contain the package name" would still pass the main assertion by accident on a
 * tree where the prose happened to live in an allowlisted file.
 */
const PROSE_ONLY_CONTROL = 'packages/engine-claude-agent-sdk/src/compile.ts';

// ── 1. Classifying every tracked file ────────────────────────────────────────────────────

/** Extensions whose contents are scanned as JavaScript/TypeScript module source. */
const MODULE_SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

/**
 * Markup that can carry a `<script>` element, an `importmap`, or a `src`/`href` that names a
 * module. Scanned by the URL arm described in the header.
 */
const MARKUP_EXTENSIONS = new Set(['.html', '.htm']);

/**
 * Structured data. Cannot import anything, but *can* declare a dependency, which is what the
 * manifest assertion reads it for.
 */
const STRUCTURED_DATA_EXTENSIONS = new Set(['.json']);

/**
 * Extensions that cannot reference a module under any resolution this repository uses.
 *
 * Markdown is here on purpose and is the reason the whole gate exists in this shape:
 * the R-01 research note contains fenced code that imports the SDK, and it is
 * prose about the SDK, not a module. A gate that grepped the tree for the package name would
 * have to exclude `docs/`, and an excluded directory is a directory the gate no longer covers.
 */
const INERT_EXTENSIONS = new Set([
  '.md',
  '.mdx',
  '.txt',
  '.yml',
  '.yaml',
  '.toml',
  // Wrangler configs (infra/cloudflare): JSON with comments, read by wrangler, never a manifest.
  '.jsonc',
  // The Lean specification (formal/, ADR-0062): a Lean `import` names Lean modules only.
  '.lean',
  '.ini',
  '.csv',
  '.sql',
  '.sh',
  '.bash',
  '.ps1',
  '.css',
  '.scss',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.webp',
  '.avif',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.pdf',
  // A Word draft (tests/gallery/contract-review): a zip of XML parts, opened by a docx reader.
  '.docx',
  // An Excel workbook (tests/gallery/excel-consolidation): a zip of XML parts, opened by an xlsx reader.
  '.xlsx',
  '.zip',
  '.patch',
  '.diff',
  '.lock',
  // Added by W1-INT-02, each with the positive reason it is inert rather than "no rule matched":
  //   .conf  a configuration file for a daemon — `apps/web/server/runs/acceptance/nginx.conf` is
  //          the case that forced the decision. nginx parses its own directive grammar; it has no
  //          JavaScript module resolver and cannot reach a node package under any resolution this
  //          repository uses.
  //   .env   KEY=VALUE lines read by docker compose and by `process.env`. A value is a string that
  //          reaches a program's environment, never a module specifier.
  '.conf',
  '.env',
  '.hcl',
  '.service',
  '.tf',
  '.tfvars',
  '.tftpl',
  // A Helm named-template partial (infra/helm/*/templates/_helpers.tpl), read by helm only.
  '.tpl',
  '.timer',
  // Added by the use-case gallery (tests/gallery/), as fixture data a tool reads as text:
  //   .dxf  an ASCII CAD drawing (group code / value line pairs); no module resolver reads it.
  //   .vtt  a WebVTT meeting transcript (timestamps and speaker lines).
  '.dxf',
  '.vtt',
  // A vitest snapshot (packages/cli/src/create/__snapshots__/): `exports[name] = string` lines
  // that vitest's snapshot reader parses itself; it holds recorded output, never a specifier.
  '.snap',
]);

/**
 * Suffixes that mean "a template of the file this name would otherwise be".
 *
 * `.env.example` is the case that forced this: its extension is `.example`, which no table above
 * names, so it fell through to `'unclassified'` and failed the gate. Adding `.example` to the inert
 * list would have been the quick answer and the wrong one — it would have made `handler.ts.example`
 * inert too, and a committed TypeScript template that imports the SDK is exactly the kind of file
 * this gate exists to see. So the suffix is *stripped* and the remainder is classified: `.env.example`
 * is classified as `.env`, and `handler.ts.example` is classified as module source and scanned.
 */
const TEMPLATE_SUFFIXES = ['.example', '.sample', '.template'] as const;

/**
 * Build files. `Dockerfile`, and `<stage>.Dockerfile` for a repository with more than one image —
 * `runtime.Dockerfile` is the case that forced it. Docker's builder parses its own instruction
 * grammar; the module references in a `RUN node …` line are resolved by a node inside the image,
 * against that image's file system, not against this repository's module graph.
 */
function isDockerfile(base: string): boolean {
  return base === 'Dockerfile' || base.endsWith('.Dockerfile');
}

/** Files with no extension, or whose whole name is the extension. Same reasoning as above. */
const INERT_BASENAMES = new Set([
  'LICENSE',
  'LICENCE',
  'NOTICE',
  'CODEOWNERS',
  'Dockerfile',
  // elan's toolchain pin for the Lean specification (formal/lean-toolchain, ADR-0062).
  'lean-toolchain',
  '.gitignore',
  '.gitattributes',
  '.gitkeep',
  '.gitmodules',
  // gitleaks reads fingerprints from it; it is a list of ignored findings, never loaded as code.
  '.gitleaksignore',
  '.npmrc',
  '.nvmrc',
  '.dockerignore',
  '.gcloudignore',
  '.prettierignore',
  '.eslintignore',
  '.editorconfig',
  // `path.extname('.env')` is the empty string — Node treats a leading dot as the whole name, not
  // as an extension — so a dotfile has to be named here even when its "extension" is listed above.
  // `.env.example` reaches this table through TEMPLATE_SUFFIXES.
  '.env',
  // `env` is a `.env` document that had to give up its leading dot to stay committed: `.gitignore`
  // excludes `.env`, so the goldens that pin what `create-agent-workspace` renders
  // (`packages/cli/src/fixtures/<cloud>/env`) are named for the artefact without it. The contents
  // are the KEY=VALUE lines the `.env` entry above describes, and the positive reason is the same
  // one: a value reaches a program's environment, never a module resolver.
  'env',
  // `gitignore` is the same rule applied to the other rendered dotfile: the goldens drop the
  // leading dot so they stay committed, and the contents are path patterns git reads.
  'gitignore',
]);

type FileClass = 'module-source' | 'markup' | 'structured-data' | 'inert' | 'unclassified';

/**
 * Which of the four kinds a tracked file is — and `'unclassified'` for anything else.
 *
 * ADR-0015's rule applied to the *inputs* of the scan rather than its outputs. The previous
 * version of this gate filtered the tree down to a set of source extensions and silently ignored
 * the remainder, so a module in a file kind nobody had thought about — the Wave 1a route-file
 * failure, one directory over — would have been invisible to the gate that exists to forbid it.
 * There is no default branch here that lets a file through: an extension this function has never
 * seen returns `'unclassified'`, and the assertion on that set is that it is empty.
 */
function classifiedBasename(file: string): string {
  let base = path.basename(file);
  // Applied first and repeatedly, so `x.ts.example.template` classifies as the `.ts` it is a
  // template of. A name that is *only* a suffix (`.example`) is left alone: stripping it would
  // leave nothing to classify, and the fall-through below is what must decide it.
  for (;;) {
    const suffix = TEMPLATE_SUFFIXES.find((s) => base.toLowerCase().endsWith(s) && base !== s);
    if (suffix === undefined) break;
    base = base.slice(0, -suffix.length);
  }
  return base;
}

function classifyFile(file: string): FileClass {
  const base = classifiedBasename(file);
  if (INERT_BASENAMES.has(base) || isDockerfile(base)) return 'inert';
  const ext = path.extname(base).toLowerCase();
  if (MODULE_SOURCE_EXTENSIONS.has(ext)) return 'module-source';
  if (MARKUP_EXTENSIONS.has(ext)) return 'markup';
  if (STRUCTURED_DATA_EXTENSIONS.has(ext)) return 'structured-data';
  if (INERT_EXTENSIONS.has(ext)) return 'inert';
  return 'unclassified';
}

/** A tracked JSON file node reads a package's dependency declarations from. */
function isPackageManifest(file: string): boolean {
  return classifiedBasename(file) === 'package.json';
}

// ── 1a. Classifying the research fixtures, which is what the §42 permit is derived from ──

/**
 * The extension a research probe is written in.
 *
 * Not "any module source under the directory". `docs/research/fixtures/agent-sdk/README.md`
 * tells a reader to reproduce a probe by copying it out of the repository and running it under
 * `node` in a scratch directory that has the SDK installed:
 *
 *     mkdir probe-r01 && cd probe-r01
 *     npm install @anthropic-ai/claude-agent-sdk@0.3.258
 *     node <path-to-this-dir>/extract-options.mjs
 *
 * `.mjs` is the only extension for which that instruction holds unconditionally: it is ES-module
 * source to `node` whatever manifest happens to be above it, whereas a `.js` there is ESM only
 * because the *repository root* manifest says `"type": "module"`, and is CommonJS the moment it
 * is copied to the scratch directory the README asks for — where the `import` on its first line
 * is a syntax error. A `.ts` probe is worse than that: it belongs to no `tsconfig` in this
 * repository, so it would be a committed TypeScript file that no typecheck and no lint reads, and
 * this gate would be *permitting* it to import the SDK. The permit is for evidence a reader can
 * run, so the shape is the shape that runs.
 *
 * Adding an extension here is the fix when a probe legitimately needs one; the reason goes
 * beside it, as everywhere else in this file. Doing nothing is not an option the classifier
 * below offers.
 */
const PROBE_EXTENSIONS = new Set(['.mjs']);

/**
 * What a tracked file under {@link RESEARCH_FIXTURE_ROOT} is.
 *
 *   * `probe` — executable evidence. **Permitted to import the SDK.**
 *   * `capture` — a recorded artefact or the prose around it: a JSON transcript, a README. It
 *     cannot name a module under any resolution this repository uses, so it is not permitted and
 *     does not need to be.
 *
 * There is no third answer and no default. A file at this path that is neither is a
 * `unrecognised` verdict carrying the reason, and the assertion on that set is that it is empty
 * — ADR-0027 clause 2: a hard failure naming the file, never a skip.
 *
 * The `capture` arm is derived from {@link classifyFile} rather than from a second extension
 * table, so the two cannot drift: exactly the kinds that this gate has already decided cannot
 * reference a module are the kinds that need no permit. `markup` is deliberately *not* a
 * capture — an HTML fixture names modules through `src`/`href`, and the day one is committed
 * here somebody has to decide whether it is evidence or a page, rather than have this function
 * decide by silence.
 */
type FixtureClass = 'probe' | 'capture';
type FixtureVerdict =
  { readonly kind: FixtureClass } | { readonly kind: 'unrecognised'; readonly reason: string };

function classifyResearchFixture(file: string): FixtureVerdict {
  const base = classifiedBasename(file);
  const ext = path.extname(base).toLowerCase();
  const kind = classifyFile(file);
  if (kind === 'module-source') {
    if (PROBE_EXTENSIONS.has(ext)) return { kind: 'probe' };
    return {
      kind: 'unrecognised',
      reason:
        `module source under ${RESEARCH_FIXTURE_ROOT}/ whose extension is not one this gate ` +
        `recognises as a runnable probe (${[...PROBE_EXTENSIONS].join(', ')}). A probe is ` +
        `evidence a reader re-runs with node; rename it, or add its extension to ` +
        `PROBE_EXTENSIONS with the reason it runs.`,
    };
  }
  if (kind === 'inert' || kind === 'structured-data') return { kind: 'capture' };
  return {
    kind: 'unrecognised',
    reason:
      `classified '${kind}' — a file under ${RESEARCH_FIXTURE_ROOT}/ is either a runnable probe ` +
      `or an inert capture, and this is neither, so no one has decided whether the §42 permit ` +
      `covers it.`,
  };
}

// ── 2. Finding candidate references with the TypeScript AST ──────────────────────────────

/** One reference this gate could not decide, described so a human can act on it. */
type Undecidable = { readonly file: string; readonly reason: string };

/** One module reference found in a syntax tree, with the form it was written in. */
type ModuleReference = { readonly specifier: string; readonly form: string };

/**
 * The three node kinds that apply a value to arguments, and so the three the classifier decides.
 *
 * `new X(…)` is here because a constructor is a callable handed arguments like any other, and
 * because at least one of them really loads a module: `new Worker(path)` starts a thread whose
 * entry point node resolves and executes. The arm that used to exclude it asserted the opposite,
 * and a tracked file that ran the SDK through it passed this gate.
 */
type DecidableCall = ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression;

/**
 * Calls whose specifier this gate reads directly. The name is the dotted callee text the AST
 * reports, so `require.resolve` is one entry rather than a `require` that has to be told about a
 * property.
 *
 * **This table is a fast path, not the decision.** ADR-0031 clause 1: a callee that is in none of
 * the three tables here is not thereby innocent — it reaches {@link decideUnrecognisedCall}, which
 * refuses it if it is handed anything that resolves to a module. What this table buys is the
 * *specifier*: a call it names is a reference the gate collects and resolves, rather than a
 * construct it declines to decide.
 */
const RESOLVER_CALLS = new Set(['import', 'require', 'require.resolve', 'import.meta.resolve']);

/**
 * Constructs that manufacture a module reference at run time, so no static walk can decide them.
 *
 * `Function` is here without `new` as well as with it: `Function('s', 'return import(s)')` builds
 * exactly the same thing as `new Function(…)`, and the pattern this replaced only matched the
 * `new` form. The AST reports the callee of a `CallExpression` and of a `NewExpression` the same
 * way, so one entry covers both.
 *
 * Also a fast path: these two are refused *whatever* they are handed, and with a reason that says
 * why, where the classifier's own refusal only fires on an argument it could read.
 */
const OPAQUE_CALLS = new Set(['eval', 'Function']);

/**
 * Property accesses that hand out a resolver this gate cannot follow, refused where they are
 * written rather than where the resolver they produced is called.
 *
 * A fast path again, and the same warning: `module.require` is deliberately *not* here. It is
 * refused by {@link decideUnrecognisedCall} because that classifier does not recognise it, which is
 * the formulation that terminates — adding the name would be one more round of the enumeration
 * ADR-0031 was written to stop.
 */
const OPAQUE_PROPERTIES = new Set(['process.binding', 'module.constructor']);

/**
 * `createRequire`, the one construct that builds a resolver and is nevertheless decidable.
 *
 *   * a `createRequire` call **immediately** followed by `.resolve` on a string literal, or called
 *     directly on one, names exactly that literal. The specifier is extracted and resolved like
 *     any other, so the call is not merely tolerated — it is *scanned*.
 *   * a `createRequire` call whose result is used any other way — bound to a name, returned,
 *     passed on, or called with something that is not a string literal — is undecidable and is
 *     reported, because every later call through that binding could name anything.
 *
 * Recorded in docs/adr/W1-INT-02-what-the-boundary-scan-classifies-and-what-it-decides.md.
 */
const CREATE_REQUIRE = 'createRequire';

/** Which `ts.ScriptKind` a file's extension is parsed as, so JSX and TSX both parse. */
function scriptKindFor(file: string): ts.ScriptKind {
  switch (path.extname(file).toLowerCase()) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * The dotted name of a callee, or `null` when it is not a plain chain of identifiers.
 *
 * `null` is the answer for `createRequire(u).resolve` and for anything else computed, which is
 * what keeps a dotted resolver from being half-recognised: the caller then falls through to the
 * `createRequire` rules or to nothing, rather than matching `require.resolve` on a coincidence.
 */
function dottedName(node: ts.Node): string | null {
  if (node.kind === ts.SyntaxKind.ImportKeyword) return 'import';
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isMetaProperty(node)) {
    const keyword = node.keywordToken === ts.SyntaxKind.ImportKeyword ? 'import' : 'new';
    return `${keyword}.${node.name.text}`;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    const base = dottedName(node.expression);
    return base === null ? null : `${base}.${node.name.text}`;
  }
  return null;
}

/** The cooked text of a plain string literal, or `null` for anything computed. */
function literalText(node: ts.Node | undefined): string | null {
  if (node === undefined) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * `parseDiagnostics` is where the parser records syntax it could not read, and it is not in
 * TypeScript's public type. It is read anyway, because the alternative is a gate that reports no
 * references out of a file it could not parse and calls that a pass. Its absence is itself a
 * refusal below, and a control plants a real syntax error, so this cannot rot into a property
 * that is always `undefined` and always ignored.
 */
type ParsedSourceFile = ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] };

/** `createRequire` however it was imported: bare, or off a namespace. */
function isCreateRequireCallee(callee: string): boolean {
  return callee === CREATE_REQUIRE || callee.endsWith(`.${CREATE_REQUIRE}`);
}

/**
 * The identifier a callee expression is **rooted** at, or `null` when there is not one.
 *
 * Where {@link dottedName} asks "what is this callee called", this asks the only question the
 * classifier below can answer soundly: "where did the value being called come from?" It walks left
 * through property and element access, through calls, and through the wrappers that change nothing
 * — parentheses, `!`, `as`, `satisfies` — until it reaches a name or something that is not one.
 *
 * So `expect(x).toBe` roots at `expect`, `require['main']['require']` roots at `require`, and
 * `(0, require)` roots at nothing at all. The last is the answer that matters: a callee this
 * function cannot root is one the classifier cannot vouch for.
 */
function calleeRoot(node: ts.Node): string | null {
  let current: ts.Node = node;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (
      ts.isPropertyAccessExpression(current) ||
      ts.isElementAccessExpression(current) ||
      ts.isCallExpression(current) ||
      ts.isNewExpression(current) ||
      ts.isTaggedTemplateExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAwaitExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = ts.isTaggedTemplateExpression(current) ? current.tag : current.expression;
      continue;
    }
    return null;
  }
}

/**
 * What a source file binds, read once per file and used by the call-site classifier.
 *
 *   * `declared` — every name the file itself introduces: a variable, a binding element, a
 *     parameter, a function or class name, an import binding, a catch variable. A callee rooted at
 *     one of these is a value the file made, and the walk sees the code that made it.
 *   * `aliased` — the subset of those bound to a **bare name or a property chain**. `const load =
 *     require;` is the case that forced this: `load` is declared, but what it holds is whatever
 *     that other name held, which this gate has no way to follow. Declared-and-aliased is not
 *     vouched for.
 *   * `constants` — names bound exactly once, by `const`, to a string literal. That is the one step
 *     of value-tracking this gate does, and it exists so that lifting a specifier into a variable
 *     is not a way past the classifier.
 *
 * Names are collected over the **whole file**, not per scope. Two consequences, both real: a name
 * bound twice is dropped from `constants` rather than guessed at, and a callee rooted at a name
 * bound anywhere in the file is vouched for even where that binding is out of scope. The second is
 * a limit, it is stated in the header, and it is demonstrated in `where this gate's reach ends`.
 */
type FileBindings = {
  readonly declared: ReadonlySet<string>;
  readonly aliased: ReadonlySet<string>;
  readonly constants: ReadonlyMap<string, string>;
};

function fileBindings(sourceFile: ts.SourceFile): FileBindings {
  const declared = new Set<string>();
  const aliased = new Set<string>();
  const constants = new Map<string, string>();
  const notConstant = new Set<string>();

  const bind = (name: ts.Node): void => {
    if (ts.isIdentifier(name)) declared.add(name.text);
  };
  const walk = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      declared.add(node.name.text);
      const initializer = node.initializer;
      if (
        initializer !== undefined &&
        (ts.isIdentifier(initializer) ||
          ts.isPropertyAccessExpression(initializer) ||
          ts.isElementAccessExpression(initializer))
      ) {
        aliased.add(node.name.text);
      }
      const literal = literalText(initializer);
      const list = node.parent;
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      if (literal !== null && isConst && !constants.has(node.name.text)) {
        constants.set(node.name.text, literal);
      } else {
        notConstant.add(node.name.text);
      }
    } else if (ts.isBindingElement(node) || ts.isParameter(node)) {
      bind(node.name);
      if (ts.isIdentifier(node.name)) notConstant.add(node.name.text);
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node)
    ) {
      if (node.name !== undefined) {
        bind(node.name);
        notConstant.add(node.name.text);
      }
    } else if (
      ts.isImportSpecifier(node) ||
      ts.isNamespaceImport(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isImportClause(node)
    ) {
      const name = node.name;
      if (name !== undefined) {
        bind(name);
        notConstant.add(name.text);
      }
    } else if (ts.isCatchClause(node) && node.variableDeclaration !== undefined) {
      bind(node.variableDeclaration.name);
    }
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  for (const name of notConstant) constants.delete(name);
  return { declared, aliased, constants };
}

/**
 * Does this string, read at a call site in this file, name a module that really resolves?
 *
 * The classifier's whole question. It is asked of the compiler through {@link resolveSpecifier},
 * for the same reason ADR-0030 gives about specifiers: a string that resolves to a module is one
 * the toolchain would load, whatever the gate thinks the surrounding call does. A builtin is not a
 * module in this tree, and a string that resolves nowhere names nothing that could be loaded.
 */
function stringNamesAModule(containingFile: string, candidate: string): string | null {
  if (candidate === '') return null;
  const resolution = resolveSpecifier(path.join(REPO_ROOT, containingFile), candidate);
  return resolution.kind === 'resolved' ? resolution.file : null;
}

/**
 * The files decided to hold a dynamic import whose argument is computed, with the reason: the
 * module it names is chosen by the developer at run time and is never the SDK. Exact repository
 * paths only, never a glob; the assertion below pins the list to exactly this entry (ADR-0115).
 */
const COMPUTED_IMPORT_DECISIONS: ReadonlyMap<string, string> = new Map([
  [
    'packages/aw/src/tools/host-child.ts',
    "imports the developer's own run files by path; decided in ADR-0115",
  ],
]);

/**
 * Every module reference in a piece of module source, and every reference it cannot decide.
 *
 * The walk is over the syntax tree, so the specifier it reports is the **cooked** string — the
 * one `tsc` and node resolve — and the spacing a reference is written with is not a variable in
 * the answer. Both were escapes against the regular expression this replaced.
 */
function scanModuleSource(
  file: string,
  source: string,
): { references: ModuleReference[]; undecidable: Undecidable[] } {
  const references: ModuleReference[] = [];
  const undecidable: Undecidable[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(file),
  );

  const push = (specifier: string, form: string): void => {
    references.push({ specifier, form });
  };
  const refuse = (reason: string): void => {
    undecidable.push({ file, reason });
  };
  const snippet = (node: ts.Node): string => JSON.stringify(node.getText(sourceFile).slice(0, 60));

  const bindings = fileBindings(sourceFile);

  /**
   * The string this gate can read at an argument position, or `null`.
   *
   * A literal is its own value. An identifier bound once by `const` to a literal in this file is
   * that literal — the one step of value-tracking described beside {@link fileBindings}, and the
   * reason lifting a specifier into a variable does not get a call site past the classifier.
   */
  const valueAt = (node: ts.Node | undefined): string | null => {
    const literal = literalText(node);
    if (literal !== null) return literal;
    if (node !== undefined && ts.isIdentifier(node))
      return bindings.constants.get(node.text) ?? null;
    return null;
  };

  /** Every string this gate can read at a call site: its arguments, and array literals among them. */
  const stringsHandedTo = (call: DecidableCall): string[] => {
    const found: string[] = [];
    if (ts.isTaggedTemplateExpression(call)) {
      const template = call.template;
      if (ts.isNoSubstitutionTemplateLiteral(template)) found.push(template.text);
      return found;
    }
    // `new X` with no argument list at all has `arguments === undefined`, which is not the same
    // node as `new X()`. Both hand this gate nothing, and neither may throw.
    for (const argument of call.arguments ?? []) {
      // `Reflect.apply(fn, thisArg, ['@scope/pkg'])`, `fn.apply(null, [...])` and
      // `fn(...['@scope/pkg'])` all put the specifier one level in, written out at the call site
      // all the same. The spread is unwrapped first, because `...['x']` is a `SpreadElement`
      // wrapping the array literal the next test is about, and `valueAt` reads neither.
      const unwrapped = ts.isSpreadElement(argument) ? argument.expression : argument;
      const value = valueAt(unwrapped);
      if (value !== null) {
        found.push(value);
        continue;
      }
      if (ts.isArrayLiteralExpression(unwrapped)) {
        for (const element of unwrapped.elements) {
          const nested = valueAt(ts.isSpreadElement(element) ? element.expression : element);
          if (nested !== null) found.push(nested);
        }
      }
    }
    return found;
  };

  /**
   * Can this gate show the thing being called is something **this file made**?
   *
   * The only positive answer it has. A callee rooted at a name the file binds — an import, a
   * variable, a function, a class, a parameter — is a value whose origin the walk has seen; a
   * callee rooted at a free name, at `this`, or at nothing at all is a value that came from
   * somewhere this gate cannot look. A name bound to another name is *not* vouched for, which is
   * what `const load = require;` turns on.
   */
  const calleeIsFromThisFile = (calleeExpression: ts.Node): boolean => {
    const root = calleeRoot(calleeExpression);
    return root !== null && bindings.declared.has(root) && !bindings.aliased.has(root);
  };

  /**
   * Is this node an **absolute base URL** — the second half of a URL resolution?
   *
   * Two shapes, and neither is a callee name. `import.meta.url` is the language's own expression
   * for the URL of the module being compiled, reported by the parser as a meta-property; and a
   * string literal that {@link URL} parses with no base of its own is an absolute URL. A relative
   * reference plus one of those is the pair `new URL(reference, base)` is made of.
   */
  const isBaseUrl = (node: ts.Node): boolean => {
    if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === 'url' &&
      ts.isMetaProperty(node.expression)
    )
      return true;
    const literal = valueAt(node);
    return literal !== null && URL.canParse(literal);
  };

  /** Is some argument of this call an absolute base URL other than `candidate` itself? */
  const handedABaseUrl = (call: DecidableCall, candidate: string): boolean => {
    if (ts.isTaggedTemplateExpression(call)) return false;
    return (call.arguments ?? []).some((argument) => {
      const unwrapped = ts.isSpreadElement(argument) ? argument.expression : argument;
      return valueAt(unwrapped) !== candidate && isBaseUrl(unwrapped);
    });
  };

  /**
   * The `else` ADR-0031 clause 1 asks for: a verdict for every call the tables above did not name.
   *
   * The question asked is not "is this callee a resolver" — no list of callee names ever finishes
   * answering that, which is the finding this classifier exists to close. It is: *is this call
   * being handed something that resolves to a module, by a caller this gate cannot vouch for?*
   *
   * There are three verdicts and no fourth path. Each is reached **per string handed to the call**,
   * not once per call, because a call can be handed several:
   *
   *   * **collected.** The call is handed the string *together with an absolute base URL*, which is
   *     the shape a URL resolution is written in — `new URL('./sibling.ts', import.meta.url)`. That
   *     is a computation this gate can do rather than a construct it must decline, so the string is
   *     recorded as a reference and resolved like any other. This is not an exemption: if the
   *     string names the SDK, the file writing it lands in the detected set and the §42 assertion
   *     fails. It is the reason `readFileSync(new URL('./agent-form.tsx', import.meta.url))` in the
   *     tracked tree is decided instead of refused, and the reason wrapping a specifier in that
   *     shape is not a way past this gate. It collects the one candidate it is about and the loop
   *     goes on to the next: the base URL is a property of the *call*, so stopping here would leave
   *     every later string at that call site undecided.
   *   * **refused**, naming the file, the construct and the module the string resolves to — the
   *     verdict for every other unrecognised callee handed a string that resolves. A refusal ends
   *     the loop, because it is already a verdict for the whole call: the gate fails naming that
   *     file and that construct, so nothing at that site is passed over.
   *   * **decided, not a reference:** a call handed no string this gate can read as a resolvable
   *     module is not, *at this call site*, naming one. The header says plainly what that leaves
   *     outside — a specifier that arrives through a parameter or a computation — because a gate
   *     that overstates its reach is what stops the next reader looking.
   */
  const decideUnrecognisedCall = (call: DecidableCall, calleeExpression: ts.Node): void => {
    if (calleeIsFromThisFile(calleeExpression)) return;
    for (const candidate of stringsHandedTo(call)) {
      const target = stringNamesAModule(file, candidate);
      if (target === null) continue;
      if (handedABaseUrl(call, candidate)) {
        // Collect *this* candidate and keep going. The arm decides the string it is about, not
        // the call: `handedABaseUrl` asks whether the call carries a base URL, so ending the loop
        // here would leave every later string at the same call site — the SDK included — with no
        // verdict at all, which is the fall-through clause 1 forbids.
        push(candidate, 'a reference resolved against an explicit base URL');
        continue;
      }
      refuse(
        `${snippet(calleeExpression)} is handed ${JSON.stringify(candidate)}, which resolves to ` +
          `${path.relative(REPO_ROOT, target) || target}. This gate cannot show that call is not a ` +
          `module load: the callee is not one it reads a specifier from, and it is not rooted at a ` +
          `name this file binds. Refused rather than passed over (ADR-0031 clause 1) — either call ` +
          `the module reference by a name this gate reads, or bind the callee in this file so the ` +
          `walk can see what it is.`,
      );
      return;
    }
  };

  /** Decide one `createRequire` call site from the way its result is used. */
  const decideCreateRequire = (call: ts.CallExpression): void => {
    const parent: ts.Node = call.parent;
    if (ts.isCallExpression(parent) && parent.expression === call) {
      const specifier = literalText(parent.arguments[0]);
      if (specifier !== null) {
        push(specifier, `${CREATE_REQUIRE}() called on a literal`);
        return;
      }
    }
    if (ts.isPropertyAccessExpression(parent) && parent.name.text === 'resolve') {
      const grandparent: ts.Node = parent.parent;
      if (ts.isCallExpression(grandparent) && grandparent.expression === parent) {
        const specifier = literalText(grandparent.arguments[0]);
        if (specifier !== null) {
          push(specifier, `${CREATE_REQUIRE}().resolve() on a literal`);
          return;
        }
      }
    }
    refuse(
      `a ${CREATE_REQUIRE}() whose result is not used immediately on a string literal, so the ` +
        `modules it goes on to resolve cannot be decided statically: ${snippet(call)}`,
    );
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier !== undefined) {
        const specifier = literalText(moduleSpecifier);
        const form = ts.isImportDeclaration(node) ? 'an import declaration' : 'an export … from';
        if (specifier === null) refuse(`${form} whose specifier is not a string literal`);
        else push(specifier, form);
      }
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = literalText(node.moduleReference.expression);
      if (specifier === null) refuse('an import-equals whose reference is not a string literal');
      else push(specifier, 'an import-equals');
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      const specifier = ts.isLiteralTypeNode(argument) ? literalText(argument.literal) : null;
      if (specifier === null) refuse('an import type whose argument is not a string literal');
      else push(specifier, 'an import type');
    } else if (
      ts.isCallExpression(node) ||
      ts.isNewExpression(node) ||
      ts.isTaggedTemplateExpression(node)
    ) {
      // Every call site leaves this branch with a verdict, `new X(…)` included. The three fast-path
      // arms below name a construct; the last one is the `else`, and it is the one that decides the
      // rest — by what the call is handed. There is no arm here that returns without collecting a
      // reference or recording a decision, and there was: until this round `new` had one of its
      // own, and a tracked file that ran the SDK through `new Worker(path)` passed this gate.
      const calleeExpression = ts.isTaggedTemplateExpression(node) ? node.tag : node.expression;
      const callee = dottedName(calleeExpression);
      if (callee !== null && OPAQUE_CALLS.has(callee)) {
        refuse(
          `${callee}() builds a module reference at run time, so no static walk of this file can decide what it reaches`,
        );
      } else if (callee !== null && ts.isCallExpression(node) && RESOLVER_CALLS.has(callee)) {
        const argument = node.arguments[0];
        const specifier = valueAt(argument);
        if (specifier === null && callee === 'import' && COMPUTED_IMPORT_DECISIONS.has(file)) {
          // A decided exception (ADR-0115), for the one file and the dynamic kind it names.
        } else if (specifier === null) {
          refuse(
            `a ${callee}() call whose argument is not a string literal, so this gate cannot tell ` +
              `which module it names: ${argument === undefined ? '(no argument)' : snippet(argument)}`,
          );
        } else {
          push(specifier, `a ${callee}() call`);
        }
      } else if (callee !== null && ts.isCallExpression(node) && isCreateRequireCallee(callee)) {
        decideCreateRequire(node);
      } else {
        decideUnrecognisedCall(node, calleeExpression);
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const accessed = dottedName(node);
      if (accessed !== null && OPAQUE_PROPERTIES.has(accessed)) {
        refuse(
          `${accessed} hands out a module resolver this gate cannot follow, so what this file reaches cannot be decided statically`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };

  // The triple-slash directives, which are module references the walk below never reaches: the
  // parser lifts them off the token stream onto the source file rather than leaving them in the
  // tree. `types` names a package the way an `import` does, so it is resolved the same way. `path`
  // names a file relative to this one and is written without a leading `./`, so it is normalised
  // into the relative form this gate's resolver understands. `lib` names a file that ships inside
  // the TypeScript compiler — not a package, and not something a resolution can reach — so it is
  // decided rather than collected, which is why there is no fourth arm and no silent remainder.
  for (const directive of sourceFile.typeReferenceDirectives) {
    push(directive.fileName, 'a /// <reference types> directive');
  }
  for (const directive of sourceFile.referencedFiles) {
    const relative = /^[./\\]/.test(directive.fileName)
      ? directive.fileName
      : `./${directive.fileName}`;
    push(relative, 'a /// <reference path> directive');
  }

  const parseDiagnostics = (sourceFile as ParsedSourceFile).parseDiagnostics;
  if (parseDiagnostics === undefined) {
    refuse(
      'the TypeScript parser did not report whether it could read this file, so this gate cannot ' +
        'tell whether the references it found are all of them',
    );
  } else if (parseDiagnostics.length > 0) {
    const first = parseDiagnostics[0];
    refuse(
      `the TypeScript parser reported ${parseDiagnostics.length} syntax error(s), so the ` +
        `references found in it are not necessarily all of them: ` +
        `${first === undefined ? '?' : ts.flattenDiagnosticMessageText(first.messageText, ' ')}`,
    );
  }
  visit(sourceFile);
  return { references, undecidable };
}

// ── 3. Resolving a reference with the compiler ───────────────────────────────────────────

/**
 * A `tsconfig` diagnostic about the project's *input file list*, which this gate never reads.
 *
 * 18002 is "the `files` list in config file … is empty" and 18003 is "no inputs were found";
 * the repository root `tsconfig.json` deliberately carries `"files": []` and `"include": []`
 * because it exists to hold options and compile nothing. This gate reads
 * `ParsedCommandLine.options` and never `fileNames`, so neither diagnostic says anything about
 * whether the options came back intact. Every other error is a config this gate could not read,
 * and it throws.
 */
const CONFIG_DIAGNOSTICS_ABOUT_INPUTS = new Set([18002, 18003]);

const CONFIG_HOST: ts.ParseConfigFileHost = {
  useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
  readDirectory: (rootDir, extensions, excludes, includes, depth) =>
    ts.sys.readDirectory(rootDir, extensions, excludes, includes, depth),
  fileExists: (file) => ts.sys.fileExists(file),
  readFile: (file) => ts.sys.readFile(file),
  getCurrentDirectory: () => REPO_ROOT,
  onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
    throw new Error(
      `a tsconfig this gate needs could not be read: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
    );
  },
};

const optionsByConfig = new Map<string, ts.CompilerOptions>();

/**
 * The compiler options of one `tsconfig.json`, with its whole `extends` chain applied.
 *
 * `ts.getParsedCommandLineOfConfigFile` is the API `tsc` itself uses, which is the entire point:
 * an `extends` target whose extension is not `.json`, a `baseUrl`, a `paths` block declared two
 * configs up — all of them arrive here without this file knowing they exist.
 *
 * `allowJs` and `resolveJsonModule` are forced on. Both only widen what resolves, and the widening
 * is the safe direction: without them a `.js` or `.json` reference from a project that has not
 * enabled them would come back unresolved and fail the gate as undecidable.
 */
function optionsForConfig(configPath: string): ts.CompilerOptions {
  const cached = optionsByConfig.get(configPath);
  if (cached !== undefined) return cached;
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, CONFIG_HOST);
  if (parsed === undefined) {
    throw new Error(`${configPath} could not be parsed, so this gate cannot resolve against it.`);
  }
  const fatal = parsed.errors.filter(
    (diagnostic) =>
      diagnostic.category === ts.DiagnosticCategory.Error &&
      !CONFIG_DIAGNOSTICS_ABOUT_INPUTS.has(diagnostic.code),
  );
  if (fatal.length > 0) {
    throw new Error(
      `${configPath} reported ${fatal.length} configuration error(s), so the options this gate resolves with are not the ones the compiler would use: ${fatal
        .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
        .join('; ')}`,
    );
  }
  const options: ts.CompilerOptions = { ...parsed.options, allowJs: true, resolveJsonModule: true };
  optionsByConfig.set(configPath, options);
  return options;
}

/**
 * The project a file resolves in: the nearest `tsconfig.json` above it.
 *
 * That is the same search an editor and type-aware ESLint do for a file, and it throws rather
 * than falling back to a default option set — a file this gate cannot find a project for is a
 * file whose references it cannot resolve the way anything else in the repository would.
 */
function optionsForFile(absoluteFile: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(
    path.dirname(absoluteFile),
    (file) => ts.sys.fileExists(file),
    'tsconfig.json',
  );
  if (configPath === undefined) {
    throw new Error(
      `no tsconfig.json was found above ${absoluteFile}, so this gate has no project to resolve its module references against.`,
    );
  }
  return optionsForConfig(configPath);
}

/** The canonical location of a path: symlinks followed, so the pnpm store and its links agree. */
function realPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * What a reference points at.
 *
 * `'builtin'` is a decision, not a skip: node's own `isBuiltin` says the specifier names the
 * runtime, and the runtime is not a package in this tree. `'unresolved'` is the refusal ADR-0030
 * clause 3 asks for, and the caller turns it into a failure naming the file.
 */
type Resolution =
  | { readonly kind: 'resolved'; readonly file: string; readonly through: string }
  | { readonly kind: 'builtin' }
  | { readonly kind: 'unresolved' };

/**
 * Resolve one specifier the way the toolchain would, and canonicalise the answer.
 *
 * The three arms and why each exists are in the header. Nothing here compares specifier text
 * against anything.
 */
function resolveSpecifier(absoluteContainingFile: string, specifier: string): Resolution {
  const own = ts.resolveModuleName(
    specifier,
    absoluteContainingFile,
    optionsForFile(absoluteContainingFile),
    ts.sys,
  );
  const resolved = own.resolvedModule?.resolvedFileName;
  if (resolved !== undefined) {
    return {
      kind: 'resolved',
      file: realPath(resolved),
      through: 'the project that owns the file',
    };
  }
  if (specifier.startsWith('.')) {
    const joined = path.resolve(path.dirname(absoluteContainingFile), specifier);
    if (isFile(joined)) {
      return { kind: 'resolved', file: realPath(joined), through: 'the relative path it spells' };
    }
    return { kind: 'unresolved' };
  }
  if (isBuiltin(specifier)) return { kind: 'builtin' };
  const boundary = path.join(REPO_ROOT, SDK_BOUNDARY);
  const confined = ts.resolveModuleName(specifier, boundary, optionsForFile(boundary), ts.sys);
  const viaConfined = confined.resolvedModule?.resolvedFileName;
  if (viaConfined !== undefined) {
    return {
      kind: 'resolved',
      file: realPath(viaConfined),
      through: 'the package that declares the confined SDK',
    };
  }
  return { kind: 'unresolved' };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * The name of the package that owns a resolved file, read from the `package.json` a resolver
 * would read it from.
 *
 * This is what replaces "does the specifier text start with the package name". A vendored copy of
 * the SDK, the pnpm content-addressed store, a workspace symlink and a `paths` alias all land on
 * a file whose owning manifest says `@anthropic-ai/claude-agent-sdk`, and none of them has to be
 * enumerated here.
 */
function owningPackageName(resolvedFile: string): string | null {
  let dir = path.dirname(path.resolve(resolvedFile));
  for (;;) {
    const manifest = path.join(dir, 'package.json');
    if (existsSync(manifest)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(manifest, 'utf8')) as unknown;
      } catch (error) {
        throw new Error(
          `${manifest} could not be parsed, so this gate cannot say which package owns ${resolvedFile}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const name = asRecord(parsed)?.['name'];
      if (typeof name === 'string') return name;
    }
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Is this resolved file part of the package §42 confines? */
function sdkOwns(resolvedFile: string): boolean {
  const owner = owningPackageName(resolvedFile);
  return owner !== null && SDK_PACKAGES.has(owner);
}

const FIXTURE_ROOT_ABSOLUTE = realPath(path.join(REPO_ROOT, RESEARCH_FIXTURE_ROOT));

/** Is this resolved file inside the research-fixture tree? Path containment, not text. */
function insideResearchFixtures(resolvedFile: string): boolean {
  const relative = path.relative(FIXTURE_ROOT_ABSOLUTE, path.resolve(resolvedFile));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

// ── 3a. The one verdict an unresolvable reference can get other than a refusal ───────────

/**
 * The package a **bare** specifier names, or `null` when the specifier does not name one.
 *
 * `null` is the answer that matters, and every arm below returns it for a positive reason rather
 * than by falling through:
 *
 *   * a **relative** specifier (`./x`, `../x`) names a file, not a package. ADR-0032 clause 2: it
 *     can only ever point at something this repository already contains, so one that resolves
 *     nowhere is a broken link and stays a hard failure — fixtures included;
 *   * an **absolute** specifier names a path on the machine running the gate, which is not a
 *     package either;
 *   * a **`#`-prefixed** specifier is a subpath import, resolved out of the `imports` map of a
 *     `package.json` *in this repository*. One that does not resolve is a manifest defect here,
 *     not a package somewhere else;
 *   * a specifier carrying a **scheme** (`node:`, `file:`, `https:`) is a URL. `node:` is already
 *     decided as a builtin before this is reached, and the rest name no package;
 *   * a lone **`@scope`** with no name after it is not a legal package specifier at all.
 */
function packageNameOf(specifier: string): string | null {
  if (specifier === '') return null;
  if (specifier.startsWith('.')) return null;
  if (specifier.startsWith('#')) return null;
  if (specifier.startsWith('/') || specifier.startsWith('\\')) return null;
  if (path.isAbsolute(specifier)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(specifier)) return null;
  const segments = specifier.split('/');
  const first = segments[0];
  if (first === undefined || first === '') return null;
  if (!first.startsWith('@')) return first;
  const second = segments[1];
  if (first.length < 2 || second === undefined || second === '') return null;
  return `${first}/${second}`;
}

/** Characters that continue a package name, so a match ending on one is a *different* package. */
const PACKAGE_NAME_CONTINUES = /[A-Za-z0-9._-]/;

/**
 * Does this README name this package?
 *
 * A containment test with boundaries, and the boundaries are the whole of it: a plain
 * `includes` would let `@modelcontextprotocol/sdk-experimental` document
 * `@modelcontextprotocol/sdk`, which is the fail-open shape this clause exists to stop. A match is
 * accepted when the character before it does not continue a name — and is not `/`, which would make
 * the match the tail of a longer path — and the character after it does not continue one either.
 * `@` and `/` after the name are the two that must still count: `…/sdk@1.30.0` is a version pin and
 * `…/sdk/client/stdio.js` is a subpath, and both are the package being named.
 */
function namesPackage(text: string, packageName: string): boolean {
  for (let from = 0; ;) {
    const at = text.indexOf(packageName, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : (text[at - 1] ?? '');
    const after = text[at + packageName.length] ?? '';
    const continues = (character: string): boolean =>
      character !== '' && PACKAGE_NAME_CONTINUES.test(character);
    if (!continues(before) && before !== '/' && !continues(after)) return true;
    from = at + 1;
  }
}

/** A README this gate read, so a failure can name the file a reader has to edit. */
type FixtureReadme = { readonly file: string; readonly text: string };

/**
 * What an unresolvable reference is. Two verdicts and no third path.
 *
 *   * `refused` — the ADR-0031 clause 1 hard failure, naming the file and the reference. Every
 *     reference outside the fixture tree, and every one inside it that fails any of the three
 *     conditions in the header, arrives here.
 *   * `undeclared-package` — the ADR-0032 clause 1 classification: *a package this repository does
 *     not declare, in a directory nothing here imports*. It is recorded by name and asserted as a
 *     set; it is never a skip.
 */
type UnresolvedVerdict =
  | { readonly kind: 'refused'; readonly reason: string }
  | {
      readonly kind: 'undeclared-package';
      readonly packageName: string;
      readonly readme: string;
    };

/**
 * Decide one reference the resolver placed nowhere.
 *
 * The README is reached through a parameter rather than read here, so the clause-3 red proof can be
 * run: the assertion below hands this function a README with the package name taken out and watches
 * the verdict turn into a refusal, without a committed README being edited to prove it.
 */
function decideUnresolvedReference(
  file: string,
  reference: ModuleReference,
  readmeFor: (fixtureFile: string) => FixtureReadme | null,
): UnresolvedVerdict {
  const refused = (addendum: string): UnresolvedVerdict => ({
    kind: 'refused',
    reason:
      `${reference.form} names ${JSON.stringify(reference.specifier)}, and neither the project ` +
      `that owns this file nor the package that declares the SDK could resolve it, so this gate ` +
      `cannot say which file it reaches${addendum}`,
  });
  if (!isResearchFixture(file)) return refused('');
  const packageName = packageNameOf(reference.specifier);
  if (packageName === null) {
    return refused(
      `. It is under ${RESEARCH_FIXTURE_ROOT}/, where a bare specifier naming a package this ` +
        `repository does not declare is a classified verdict — but this specifier names no ` +
        `package. A relative or absolute reference points at a file this repository contains ` +
        `wherever it is written, so one that resolves nowhere is a broken link and is refused ` +
        `here exactly as it is everywhere else (ADR-0032 clause 2).`,
    );
  }
  const readme = readmeFor(file);
  if (readme === null) {
    return refused(
      `. It is under ${RESEARCH_FIXTURE_ROOT}/ and names the package ${packageName}, which this ` +
        `repository does not declare — but no README.md between this file and ` +
        `${RESEARCH_FIXTURE_ROOT}/ says where that package comes from, so nothing here documents ` +
        `the installation the probe is run from (ADR-0032 clause 3).`,
    );
  }
  if (!namesPackage(readme.text, packageName)) {
    return refused(
      `. It is under ${RESEARCH_FIXTURE_ROOT}/ and names the package ${packageName}, which this ` +
        `repository does not declare — and ${readme.file} does not name ${packageName}, so the ` +
        `verdict rests on nothing. Name the package in that README, beside the install command a ` +
        `reader runs, or stop importing it here (ADR-0032 clause 3).`,
    );
  }
  return { kind: 'undeclared-package', packageName, readme: readme.file };
}

// ── 4. Markup, which resolves URLs rather than module specifiers ─────────────────────────

/** `src="…"` / `href="…"` — the way an HTML page names a resource without `import`. */
const MARKUP_ATTRIBUTE_SPECIFIER = /\b(?:src|href)\s*=\s*['"]([^'"\n]+)['"]/g;

/** The body of every `<script>` element, which is module source a browser runs. */
const MARKUP_SCRIPT_BODY = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;

/** What a markup reference points at once the URL algorithm has been applied to it. */
type MarkupTarget =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'remote'; readonly href: string; readonly pathname: string }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * Resolve a markup reference the way a browser does: as a URL against the document's own URL.
 *
 * A `file:` result is a path in this checkout and is decided like any other resolved path. A
 * result on another origin is a resource this gate has no resolver for, and the only thing it can
 * compare is the URL's own resolved path — see the header, and the ADR's declared gaps.
 */
function resolveMarkupReference(absoluteDocument: string, reference: string): MarkupTarget {
  let url: URL;
  try {
    url = new URL(reference, pathToFileURL(absoluteDocument));
  } catch (error) {
    return {
      kind: 'unreadable',
      reason: `the reference ${JSON.stringify(reference)} is not a URL a browser could resolve against this document: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (url.protocol === 'file:') {
    const bare = new URL(url.href);
    bare.hash = '';
    bare.search = '';
    try {
      return { kind: 'file', path: realPath(fileURLToPath(bare)) };
    } catch (error) {
      return {
        kind: 'unreadable',
        reason: `the reference ${JSON.stringify(reference)} resolved to ${bare.href}, which names no path this gate can compare: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { kind: 'remote', href: url.href, pathname: decodeURIComponent(url.pathname) };
}

/**
 * Does a path name a package by its directory segments?
 *
 * Used only on the markup arm, and only on a **resolved** URL path — never on the text a
 * reference was written with. `@anthropic-ai/claude-agent-sdk` is two segments, so this looks for
 * those two segments in order rather than for a substring, and derives them from
 * {@link SDK_PACKAGE} rather than repeating them.
 */
function pathNamesPackage(candidate: string, packageName: string): boolean {
  const wanted = packageName.split('/');
  const segments = candidate.split(/[\\/]+/).filter((segment) => segment.length > 0);
  for (let i = 0; i + wanted.length <= segments.length; i += 1) {
    if (wanted.every((segment, j) => segments[i + j] === segment)) return true;
  }
  return false;
}

function markupTargetIsSdk(target: MarkupTarget): boolean {
  if (target.kind === 'file') {
    return (
      sdkOwns(target.path) || [...SDK_PACKAGES].some((name) => pathNamesPackage(target.path, name))
    );
  }
  if (target.kind === 'remote') {
    return [...SDK_PACKAGES].some((name) => pathNamesPackage(target.pathname, name));
  }
  return false;
}

function markupTargetIsFixture(target: MarkupTarget): boolean {
  if (target.kind === 'file') {
    return (
      insideResearchFixtures(target.path) || pathNamesPackage(target.path, RESEARCH_FIXTURE_ROOT)
    );
  }
  if (target.kind === 'remote') return pathNamesPackage(target.pathname, RESEARCH_FIXTURE_ROOT);
  return false;
}

/** Every reference an HTML document makes: its `src`/`href` attributes and its inline scripts. */
function markupReferences(
  file: string,
  source: string,
): { references: string[]; undecidable: Undecidable[] } {
  const references: string[] = [];
  const undecidable: Undecidable[] = [];
  for (const match of source.matchAll(MARKUP_ATTRIBUTE_SPECIFIER)) {
    const reference = match[1];
    if (reference !== undefined) references.push(reference);
  }
  for (const match of source.matchAll(MARKUP_SCRIPT_BODY)) {
    const body = match[1];
    if (body === undefined || body.trim() === '') continue;
    // The body is JavaScript, so its references are found the same way every other module's are —
    // by the syntax tree. They are *resolved* as URLs, because a browser is what runs them. The
    // pseudo-name ends in `.js` so the body is parsed as JavaScript rather than as TypeScript.
    const scan = scanModuleSource(`${file}#inline-script.js`, body);
    undecidable.push(...scan.undecidable.map((entry) => ({ file, reason: entry.reason })));
    references.push(...scan.references.map((reference) => reference.specifier));
  }
  return { references, undecidable };
}

// ── 5. The tracked tree ──────────────────────────────────────────────────────────────────

/**
 * The tracked tree.
 *
 * Throws rather than falling back to an empty list if git cannot be read: every assertion below
 * is quantified over this array, and an empty array satisfies all of them vacuously. A gate that
 * cannot run must fail (ADR-0015).
 */
function trackedFiles(): string[] {
  // No pathspec: `git ls-files` is asked for the whole tree, and every narrowing of it happens
  // in this file where a reader can see it. A pathspec here would be a directory exclusion in
  // the one place the header promises there is none.
  const stdout = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  // `-z` terminates each name with a NUL, so the split leaves one empty string at the end (and
  // nothing else empty — git never lists a path with no name). Declared narrowing: this drops
  // that terminator, not a file.
  const files = stdout.split('\0').filter((f) => f.length > 0);
  if (files.length === 0) {
    throw new Error(
      '`git ls-files` returned nothing, so this gate has no tree to scan. It must fail rather than report a repository with no SDK imports.',
    );
  }
  return files;
}

/**
 * The contents of a tracked file, read from the **working tree** — see the header section
 * "Names come from git, contents come from the working tree" for why that split is deliberate.
 *
 * A file git lists and the working tree does not have throws rather than being skipped: a name
 * this gate cannot read is a file whose imports it cannot see.
 */
function readTracked(file: string): string {
  const absolute = path.join(REPO_ROOT, file);
  if (!existsSync(absolute)) {
    throw new Error(
      `${file} is tracked by git but absent from the working tree, so this gate could not scan it.`,
    );
  }
  return readFileSync(absolute, 'utf8');
}

const tracked = trackedFiles();
const trackedSet = new Set(tracked);
const readmeCache = new Map<string, FixtureReadme | null>();

/**
 * The nearest tracked `README.md` at or above a fixture, stopping at {@link RESEARCH_FIXTURE_ROOT}.
 *
 * `null` — no README covers the file — is a refusal at the call site, not a pass: ADR-0032 clause 3
 * makes the README the thing the classification rests on, so a fixture no README covers has nothing
 * to rest on. The search is over `tracked`, so an untracked README documents nothing, which is the
 * same boundary the header draws for every other file this gate reads.
 *
 * The climb is **bounded below the fixture root at both ends**, and the assertion below is what
 * found that it had to be: a file outside the tree is `null` before the walk starts, and a file
 * inside it stops at {@link RESEARCH_FIXTURE_ROOT} rather than continuing into `docs/`. Without
 * the first bound this returned `docs/research/README.md` — a research-note checklist that has
 * nothing to say about anybody's installation — for a path that is not a fixture at all.
 */
function researchFixtureReadme(file: string): FixtureReadme | null {
  if (!isResearchFixture(file)) return null;
  const cached = readmeCache.get(file);
  if (cached !== undefined) return cached;
  let found: FixtureReadme | null = null;
  // git reports paths with forward slashes on every platform, so the posix functions are the ones
  // that split them — `path.dirname` on win32 would also split on a backslash a name may contain.
  let dir = path.posix.dirname(file);
  for (;;) {
    const candidate = `${dir}/README.md`;
    if (trackedSet.has(candidate)) {
      found = { file: candidate, text: readTracked(candidate) };
      break;
    }
    if (dir === RESEARCH_FIXTURE_ROOT) break;
    const up = path.posix.dirname(dir);
    if (up === dir || !up.startsWith(RESEARCH_FIXTURE_ROOT)) break;
    dir = up;
  }
  readmeCache.set(file, found);
  return found;
}

const classified = new Map<string, FileClass>(tracked.map((f) => [f, classifyFile(f)]));
const unclassified = tracked.filter((f) => classified.get(f) === 'unclassified');
const scanned = tracked.filter(
  (f) => classified.get(f) === 'module-source' || classified.get(f) === 'markup',
);
const packageManifests = tracked.filter(
  (f) => classifyFile(f) === 'structured-data' && isPackageManifest(f),
);

/**
 * The §42 permit, derived from the tracked tree by shape (ADR-0027).
 *
 * Note which direction each of these two partitions fails in, because they are opposites and
 * this file depends on both:
 *
 *   * `researchProbes` is the **permitted** set. A file wrongly *dropped* from it makes the gate
 *     **stricter** — it becomes an unexpected importer and the §42 equality goes red naming it.
 *     That is the safe direction, which is why an `unrecognised` fixture is left out of the
 *     permit *as well as* being reported: the two failures point at the same file.
 *   * `scanned` is the **inspected** set. A file wrongly dropped from *it* is never read, so its
 *     imports are invisible and the gate **fails open**. Nothing here narrows `scanned`; it is
 *     still every `module-source` and `markup` file in the tracked tree with no exclusion, and
 *     the assertion below is that every derived probe is inside it — a permit for a file this
 *     gate does not read would be a permit nobody can see the effect of.
 */
const researchFixtures = tracked.filter(isResearchFixture);
const fixtureVerdicts = new Map<string, FixtureVerdict>(
  researchFixtures.map((f) => [f, classifyResearchFixture(f)]),
);
const researchProbes = researchFixtures
  .filter((f) => fixtureVerdicts.get(f)?.kind === 'probe')
  .sort((a, b) => a.localeCompare(b));
const unrecognisedFixtures = researchFixtures
  .filter((f) => fixtureVerdicts.get(f)?.kind === 'unrecognised')
  .map((f) => {
    const verdict = fixtureVerdicts.get(f);
    return `${f}: ${verdict !== undefined && verdict.kind === 'unrecognised' ? verdict.reason : '?'}`;
  });

const undecidable: Undecidable[] = [];
const importers: string[] = [];
const fixtureConsumers: string[] = [];

/**
 * The ADR-0032 clause 1 classification, recorded so it can be asserted rather than skipped.
 *
 * `undeclaredFixturePackages` is the set the assertion below compares against
 * {@link PACKAGES_A_FIXTURE_INSTALLS_FOR_ITSELF}; `undeclaredFixtureEdges` is the evidence printed
 * beside a failure — which file, which specifier, and the README that documents the package — so a
 * reader can act on it without re-running anything.
 */
const undeclaredFixturePackageSet = new Set<string>();
const undeclaredFixtureEdges: string[] = [];
/**
 * Why each detected file was detected, as `file: specifier -> resolved path`.
 *
 * ADR-0030's consequence list asks for this by name: once the answer is a resolution rather than a
 * string comparison, the interesting information in a failure is the *mapping*, because the whole
 * point of the conversion is that a specifier and the file it names need not look alike. The
 * failure messages of the two set assertions below print these lines.
 */
const detectedEdges: string[] = [];
for (const file of scanned) {
  const absolute = path.join(REPO_ROOT, file);
  const source = readTracked(file);
  let reachesSdk = false;
  let reachesFixtures = false;
  const edge = (specifier: string, target: string): string =>
    `${file}: ${JSON.stringify(specifier)} -> ${path.relative(REPO_ROOT, target) || target}`;
  if (classified.get(file) === 'markup') {
    const found = markupReferences(file, source);
    undecidable.push(...found.undecidable);
    for (const reference of found.references) {
      const target = resolveMarkupReference(absolute, reference);
      if (target.kind === 'unreadable') {
        undecidable.push({ file, reason: target.reason });
        continue;
      }
      const where = target.kind === 'file' ? target.path : target.href;
      if (markupTargetIsSdk(target)) {
        reachesSdk = true;
        detectedEdges.push(edge(reference, where));
      }
      if (markupTargetIsFixture(target)) {
        reachesFixtures = true;
        detectedEdges.push(edge(reference, where));
      }
    }
  } else {
    const found = scanModuleSource(file, source);
    undecidable.push(...found.undecidable);
    for (const reference of found.references) {
      const resolution = resolveSpecifier(absolute, reference.specifier);
      if (resolution.kind === 'unresolved') {
        // Two verdicts and no third path (ADR-0032). Everything that is not the classification is
        // still the ADR-0031 refusal, with the reason saying which of the three conditions failed.
        const verdict = decideUnresolvedReference(file, reference, researchFixtureReadme);
        if (verdict.kind === 'refused') {
          undecidable.push({ file, reason: verdict.reason });
        } else {
          undeclaredFixturePackageSet.add(verdict.packageName);
          undeclaredFixtureEdges.push(
            `${file}: ${JSON.stringify(reference.specifier)} -> ${verdict.packageName}, documented in ${verdict.readme}`,
          );
        }
        continue;
      }
      if (resolution.kind === 'builtin') continue;
      if (sdkOwns(resolution.file)) {
        reachesSdk = true;
        detectedEdges.push(edge(reference.specifier, resolution.file));
      }
      if (insideResearchFixtures(resolution.file)) {
        reachesFixtures = true;
        detectedEdges.push(edge(reference.specifier, resolution.file));
      }
    }
  }
  if (reachesSdk) importers.push(file);
  // The fixture tree is left out of this one on purpose (declared in the ADR): a probe naming a
  // sibling probe is evidence citing evidence, and it is the *outward* direction — product code
  // naming a probe — that turns a permit into a dependency.
  if (!isResearchFixture(file) && reachesFixtures) fixtureConsumers.push(file);
}
const undeclaredFixturePackages = [...undeclaredFixturePackageSet].sort((a, b) =>
  a.localeCompare(b),
);
undeclaredFixtureEdges.sort((a, b) => a.localeCompare(b));
importers.sort((a, b) => a.localeCompare(b));
fixtureConsumers.sort((a, b) => a.localeCompare(b));
detectedEdges.sort((a, b) => a.localeCompare(b));
undecidable.sort((a, b) => `${a.file}: ${a.reason}`.localeCompare(`${b.file}: ${b.reason}`));

/** The whole permitted set, printed on failure because it can no longer be read off a literal. */
const PERMITTED = [...SDK_BOUNDARY_FILES, ...researchProbes].sort((a, b) => a.localeCompare(b));

/**
 * Every package a committed fixture imports and this repository does not declare.
 *
 * ADR-0032 clause 1, and this literal is the point of the clause. The verdict is a
 * *classification*, so what it classifies is written down here and compared as a set equality: a
 * probe that imports a tenth package fails this gate until somebody adds the name to this list and
 * to the fixture's README, and a package that stops being imported fails it the other way. A
 * directory exclusion would have produced neither failure, which is why ADR-0032 rejects one.
 *
 * `@modelcontextprotocol/sdk` is here because `docs/research/fixtures/R-06-mcp/README.md` prints
 * `npm init -y && npm install @anthropic-ai/claude-agent-sdk@0.3.258 @modelcontextprotocol/sdk@1.30.0`
 * and the R-06 probes are copy-out-and-run artefacts that execute from that installation. It is
 * *not* declared by any `package.json` here on purpose — R-06 is a research note, and the note's
 * evidence is not a dependency of this repository.
 */
const PACKAGES_A_FIXTURE_INSTALLS_FOR_ITSELF = ['@modelcontextprotocol/sdk'];

/** Does this source, written in this file, reach the SDK? The whole pipeline, for the fixtures. */
function sourceReachesSdk(containingFile: string, source: string): boolean {
  const absolute = path.join(REPO_ROOT, containingFile);
  return scanModuleSource(containingFile, source).references.some((reference) => {
    const resolution = resolveSpecifier(absolute, reference.specifier);
    return resolution.kind === 'resolved' && sdkOwns(resolution.file);
  });
}

// ── 6. The assertions ────────────────────────────────────────────────────────────────────

describe('the §42 boundary gate can actually run', () => {
  it('scanned the tracked tree, including the file it is asserting about', () => {
    // Not "some files were found" — these names are what make the assertions below mean
    // something. If the boundary file is missing from the scan, every "no other file reaches
    // the SDK" claim underneath is true and worthless.
    for (const row of ENGINE_SDK_BOUNDARIES) expect(scanned).toContain(row.boundaryFile);
    expect(scanned).toContain(PROSE_ONLY_CONTROL);
    expect(scanned).toContain('tests/no-sdk-import.test.ts');
    for (const row of ENGINE_SDK_BOUNDARIES) expect(packageManifests).toContain(row.manifest);
    expect(tracked).toContain(BOUNDARY_PROJECT);
  });

  it('classified every tracked file, with no default that lets one through', () => {
    // An extension nobody has thought about is the Wave 1a route-file failure in another
    // costume: the gate keeps passing, and the thing it exists to forbid is invisible to it.
    // Adding the extension to one of the four tables above is the fix; skipping it is not.
    expect(unclassified, 'tracked files whose kind this gate does not recognise').toEqual([]);
  });

  it('classifies each kind by what loads it, not by what its name failed to match', () => {
    // The three tracked files that fell through to `'unclassified'` on the Wave 1a union, each
    // asserted by name together with the rule that decides it — so the rule is visible here and
    // not only in a table above. And the negative that keeps the template rule honest: a `.ts`
    // template is scanned, because it is TypeScript wearing a suffix.
    expect(classifyFile('apps/web/server/runs/acceptance/nginx.conf')).toBe('inert');
    expect(classifyFile('runtime.Dockerfile')).toBe('inert');
    expect(classifyFile('Dockerfile')).toBe('inert');
    expect(classifyFile('.env.example')).toBe('inert');
    expect(classifyFile('.env')).toBe('inert');
    // The same document with its leading dot removed so `.gitignore` keeps its hands off it —
    // `packages/cli/src/fixtures/local/env` is the case that forced the entry.
    expect(classifyFile('packages/cli/src/fixtures/local/env')).toBe('inert');
    expect(classifyFile('apps/web/handler.ts.example')).toBe('module-source');
    expect(classifyFile('docs/page.html.template')).toBe('markup');
    expect(classifyFile('apps/runner/src/claude.ts')).toBe('module-source');
    expect(classifyFile('package.json')).toBe('structured-data');
    expect(classifyFile('docs/spec.md')).toBe('inert');
    // …and the fall-through still rejects, which is what makes the assertion above a gate.
    expect(classifyFile('deploy/service.unitfile')).toBe('unclassified');
    // The template-suffix scan is part of that fall-through and not an escape from it: a suffix
    // `TEMPLATE_SUFFIXES` does not carry is left on the name, and the classifier then decides the
    // name as it stands — `.dist` here, which no table knows, so the file is rejected by name
    // rather than passed over.
    expect(classifyFile('apps/web/handler.ts.dist')).toBe('unclassified');
  });

  it('derived a non-empty research-probe set from the tracked tree', () => {
    // ADR-0015 applied to the derivation itself. Every assertion about the permit is quantified
    // over `researchProbes`, and an empty array satisfies all of them: a renamed directory, a
    // `git ls-files` that stopped returning `docs/`, or a `PROBE_EXTENSIONS` that no longer
    // matches anything would otherwise leave this gate reporting a repository whose probes are
    // all fine because it found none. The names are not asserted — that would be the literal
    // list again — only that the rule resolves against the shipped tree.
    expect(
      researchFixtures,
      `no tracked file under ${RESEARCH_FIXTURE_ROOT}/, so the §42 permit derives from nothing`,
    ).not.toEqual([]);
    expect(
      researchProbes,
      `no probe under ${RESEARCH_FIXTURE_ROOT}/ matched ${[...PROBE_EXTENSIONS].join(', ')}; derived fixtures were: ${researchFixtures.join(', ')}`,
    ).not.toEqual([]);
  });

  it('classified every research fixture, with no default that grants or withholds a permit', () => {
    // ADR-0027 clause 2 and clause 3: the shape rule is a classifier, and the `else` rejects by
    // name. A `.ts` dropped in beside the probes is not quietly left out of the permitted set —
    // it is this failure, and the reason says what to do about it.
    expect(
      unrecognisedFixtures,
      `tracked files under ${RESEARCH_FIXTURE_ROOT}/ that are neither a runnable probe nor an inert capture`,
    ).toEqual([]);
  });

  it('inspects every file it permits', () => {
    // Every probe is inside the inspected set, so the permit is visible in `importers`. A permit
    // for a file this gate never reads would be a permit whose effect nobody can see.
    expect(
      researchProbes.filter((probe) => !scanned.includes(probe)),
      'permitted probes this gate never reads, so the permit could hide an import',
    ).toEqual([]);
  });

  it('gives a capture verdict to no kind it scans, asserted where that can fail', () => {
    // The opposite direction, and it is asserted on the classifier rather than over the tree.
    // Over the tree it would read `researchCaptures.filter((c) => scanned.includes(c))`:
    // `classifyResearchFixture` returns `capture` only where `classifyFile` returned `inert` or
    // `structured-data`, and `scanned` is built from the files where it returned `module-source`
    // or `markup` — two arms of one classifier that share no verdict, so a capture arm that grew
    // a scanned kind would not show up there. It shows up here, which is why this loop is over
    // constructed names and not over `researchCaptures`.
    //
    // The names are built from the two extension tables `scanned` is derived from, rather than
    // written out, so the property is quantified over every kind this gate scans instead of the
    // ones somebody remembered to type.
    const scannedExtensions = [...MODULE_SOURCE_EXTENSIONS, ...MARKUP_EXTENSIONS];
    expect(
      scannedExtensions,
      'no extension is scanned, so the loop below would assert nothing (ADR-0015)',
    ).not.toEqual([]);
    for (const extension of scannedExtensions) {
      const file = `${RESEARCH_FIXTURE_ROOT}/r-06/probe${extension}`;
      expect(['module-source', 'markup'], `${file} is not a kind this gate scans`).toContain(
        classifyFile(file),
      );
      expect(
        classifyResearchFixture(file).kind,
        `${file} is scanned as module source or markup, so calling it an inert capture would hand a §42 permit to a file that can name a module`,
      ).not.toBe('capture');
    }
  });

  it('holds exactly one decided computed dynamic import: the one ADR-0115 names', () => {
    expect([...COMPUTED_IMPORT_DECISIONS.keys()]).toEqual(['packages/aw/src/tools/host-child.ts']);
  });

  it('found no module reference it cannot decide', () => {
    expect(
      undecidable.map((entry) => `${entry.file}: ${entry.reason}`),
      'module references this gate cannot resolve; it refuses to pass over them',
    ).toEqual([]);
  });

  it('names every package a fixture imports that this repository does not declare', () => {
    // ADR-0032 clause 1. The classification is only sound because it is *stated*: a set equality
    // against a literal, so a probe importing a new package fails here until the name is written
    // down and the README documents it, and a package that stops being imported fails it in the
    // other direction. That is the whole difference between this and a directory exclusion, which
    // would have produced neither failure and gone quiet.
    expect(
      undeclaredFixturePackages,
      `packages a committed fixture imports and no package.json here declares. Every reference ` +
        `that produced this verdict, as file: specifier -> package: ` +
        undeclaredFixtureEdges.join(' | '),
    ).toEqual(PACKAGES_A_FIXTURE_INSTALLS_FOR_ITSELF);

    // ADR-0015 on the classification itself. The equality above is against a non-empty literal
    // today, so it already fails on an empty set — but the literal is the thing a future edit
    // changes, and a gate whose new verdict silently stopped firing is exactly the shape this
    // programme keeps finding. Asserted on the edges, which is the evidence rather than the name.
    expect(
      undeclaredFixtureEdges,
      'no reference reached the ADR-0032 classification, so the assertion above is quantified over nothing',
    ).not.toEqual([]);

    // The control that makes the verdict safe rather than merely narrow. The SDK never arrives
    // here today, because `resolveSpecifier` resolves a fixture's bare specifier a second time
    // from the package that declares it. If that arm ever broke, every probe's SDK import would
    // land in this set instead of in `importers` — §42 would go quiet and this line is what says
    // so. It is not implied by the equality above: someone repairing that failure would be
    // editing the literal.
    expect(
      undeclaredFixturePackages,
      `${SDK_PACKAGE} is the package §42 confines. Classifying it as one this repository does ` +
        `not declare would take every probe's SDK import out of the detected set, so the ` +
        `confined-package resolution arm has stopped working — repair that, not this list.`,
    ).not.toContain(SDK_PACKAGE);
  });

  it('distinguishes a reference to the package from a mention of its name', () => {
    const prose = readTracked(PROSE_ONLY_CONTROL);
    expect(prose, `${PROSE_ONLY_CONTROL} no longer mentions the package`).toContain(SDK_PACKAGE);
    expect(importers, `${PROSE_ONLY_CONTROL} is prose, not an import`).not.toContain(
      PROSE_ONLY_CONTROL,
    );
    for (const row of ENGINE_SDK_BOUNDARIES) {
      expect(importers, `${row.boundaryFile} must import ${row.sdkPackage}`).toContain(
        row.boundaryFile,
      );
    }
  });
});

describe('the walk recognises the forms a module reference takes', () => {
  // Written out in full rather than assembled from fragments. This file is scanned like every
  // other, and the scan is over its syntax tree: a specifier inside a string literal is a string,
  // not an import. The §42 equality below is what proves that — this file would be in it
  // otherwise.
  const RECOGNISED: ReadonlyArray<readonly [string, string]> = [
    ['a named import', `import { query } from '@anthropic-ai/claude-agent-sdk';`],
    ['a default import', `import sdk from '@anthropic-ai/claude-agent-sdk';`],
    ['a type-only import', `import type { Options } from '@anthropic-ai/claude-agent-sdk';`],
    ['a namespace import', `import * as sdk from "@anthropic-ai/claude-agent-sdk";`],
    ['a bare side-effect import', `import '@anthropic-ai/claude-agent-sdk';`],
    // The whitespace-free form. Valid ESM and valid TypeScript; the pattern this walk replaced
    // required `\bimport\s+` and matched nothing here, while its own table of recognised forms
    // claimed the side-effect import was covered.
    ['a bare side-effect import with no space', `import'@anthropic-ai/claude-agent-sdk';`],
    // A unicode escape in the specifier. `\u0040` is `@`: this is the SDK's real name to node and
    // to tsc, and a different string to any comparison made on raw source text.
    ['a specifier written with a string escape', `import '\\u0040anthropic-ai/claude-agent-sdk';`],
    ['a named re-export', `export { query } from '@anthropic-ai/claude-agent-sdk';`],
    ['a star re-export', `export * from '@anthropic-ai/claude-agent-sdk';`],
    ['a namespaced re-export', `export * as sdk from '@anthropic-ai/claude-agent-sdk';`],
    ['a subpath import', `import { x } from '@anthropic-ai/claude-agent-sdk/bridge';`],
    ['a dynamic import', `const m = import('@anthropic-ai/claude-agent-sdk');`],
    ['a CommonJS require', `const m = require('@anthropic-ai/claude-agent-sdk');`],
    ['a require.resolve', `const p = require.resolve('@anthropic-ai/claude-agent-sdk');`],
    ['an import.meta.resolve', `const p = import.meta.resolve('@anthropic-ai/claude-agent-sdk');`],
    ['a type position import', `type O = import('@anthropic-ai/claude-agent-sdk').Options;`],
    ['an import-equals', `import sdk = require('@anthropic-ai/claude-agent-sdk');`],
    // The triple-slash directives. The parser lifts these off the token stream onto the source
    // file, so a walk of the syntax tree alone never sees one; before this round the walk read
    // neither, and a tracked file carrying the first left the gate green.
    [
      'a reference-types directive',
      `/// <reference types="@anthropic-ai/claude-agent-sdk" />\nexport {};`,
    ],
    // A specifier lifted into a `const` and then required. The one step of value-tracking this
    // gate does, and it is what stops "put the string in a variable" being the next spelling.
    [
      'a specifier bound to a const and required through the name',
      `const spec = '@anthropic-ai/claude-agent-sdk';\nconst m = require(spec);`,
    ],
    // The two decidable `createRequire` shapes. Before W1-INT-02 the bare word was matched as
    // undecidable and the specifier beside it was never looked at, so an SDK import written this
    // way was reported as "cannot decide" rather than as what it is: an import.
    [
      'a createRequire whose result resolves a literal',
      `const p = createRequire(u).resolve('@anthropic-ai/claude-agent-sdk');`,
    ],
    [
      'a createRequire called on a literal',
      `const m = createRequire(u)('@anthropic-ai/claude-agent-sdk');`,
    ],
  ];

  it.each(RECOGNISED)('detects %s', (_label, source) => {
    expect(sourceReachesSdk(SDK_BOUNDARY, source)).toBe(true);
  });

  it('hands over the cooked specifier, not the text it was written with', () => {
    // The unit behind two of the rows above, stated on the specifier itself so that a walk which
    // detected them for some other reason could not satisfy it. Both are the same string once the
    // parser is finished with them, and neither is that string in the file's raw bytes.
    const escaped = scanModuleSource(
      'fixture.ts',
      `import '\\u0040anthropic-ai/claude-agent-sdk';`,
    );
    expect(escaped.references.map((reference) => reference.specifier)).toEqual([SDK_PACKAGE]);
    const tight = scanModuleSource('fixture.ts', `import'@anthropic-ai/claude-agent-sdk';`);
    expect(tight.references.map((reference) => reference.specifier)).toEqual([SDK_PACKAGE]);
    expect(escaped.undecidable).toEqual([]);
    expect(tight.undecidable).toEqual([]);
  });

  it('detects a markup element that names the package on another origin', () => {
    // The markup arm, which is a URL arm: there is no module resolver for a remote origin, so a
    // reference that leaves this checkout is decided on the path the URL algorithm produced.
    const document = path.join(REPO_ROOT, 'ui/index.html');
    const found = markupReferences(
      'ui/index.html',
      `<script type="module" src="https://cdn.example.invalid/@anthropic-ai/claude-agent-sdk/sdk.mjs"></script>`,
    );
    expect(found.undecidable).toEqual([]);
    expect(
      found.references.map((reference) =>
        markupTargetIsSdk(resolveMarkupReference(document, reference)),
      ),
    ).toEqual([true]);
    // …and the shape the tracked pages really use stays innocent, so the assertion above is about
    // the package and not about the word `src`.
    const innocent = markupReferences('ui/index.html', `<link href="assets/app.css">`);
    expect(
      innocent.references.map((reference) =>
        markupTargetIsSdk(resolveMarkupReference(document, reference)),
      ),
    ).toEqual([false]);
  });

  const REFUSED: ReadonlyArray<readonly [string, string]> = [
    ['a template specifier', 'const m = import(`${base}/claude-agent-sdk`);'],
    ['a variable specifier', `const m = import(name);`],
    ['a concatenated specifier', `const m = require('@anthropic-ai/' + pkg);`],
    ['a resolver bound to a name', `const req = createRequire(import.meta.url);`],
    ['a resolver called on a variable', `createRequire(import.meta.url).resolve(name);`],
    ['a resolver returned from a function', `const f = () => createRequire(u);`],
    ['a specifier assembled by eval', `const m = eval('req' + 'uire')('x');`],
    // `Function` without `new` builds the same thing as `new Function` and was absent from the
    // table this replaced; the AST reports both callees identically, so one entry covers them.
    ['a specifier assembled by Function', `const build = Function('s', 'return import(s)');`],
    [
      'a specifier assembled by new Function',
      `const build = new Function('s', 'return import(s)');`,
    ],
    ['a resolver reached through process.binding', `const m = process.binding('natives');`],
    // The four node module loaders a verifier proved past the version of this file that decided
    // which call sites to examine from tables of callee names. None of the four is named anywhere
    // in this file — see `the call-site classifier decides every call` below, which asserts that.
    [
      'a require off the CommonJS module object',
      `const m = module.require('@anthropic-ai/claude-agent-sdk');`,
    ],
    [
      'a require off require.main',
      `const m = require.main.require('@anthropic-ai/claude-agent-sdk');`,
    ],
    [
      'a require off process.mainModule',
      `const m = process.mainModule.require('@anthropic-ai/claude-agent-sdk');`,
    ],
    [
      'require rebound to a local name',
      `const load = require;\nconst m = load('@anthropic-ai/claude-agent-sdk');`,
    ],
    // And four this gate has never been shown, to make the point that the refusal is not a list.
    [
      'a loader reached through Reflect.apply with an array-literal argument',
      `const m = Reflect.apply(module.require, module, ['@anthropic-ai/claude-agent-sdk']);`,
    ],
    [
      "Module._load through require('node:module'), with the specifier in a const",
      `const spec = '@anthropic-ai/claude-agent-sdk';\nconst m = require('node:module')._load(spec, module, false);`,
    ],
    [
      'a loader reached through globalThis',
      `const m = globalThis.process.mainModule.require('@anthropic-ai/claude-agent-sdk');`,
    ],
    [
      'a loader called through a comma expression, which is rooted at no name at all',
      `const m = (0, module.require)('@anthropic-ai/claude-agent-sdk');`,
    ],
  ];

  it.each(REFUSED)('refuses %s rather than passing over it', (_label, source) => {
    expect(scanModuleSource('fixture.ts', source).undecidable).not.toEqual([]);
  });

  it('decides a createRequire whose result is used immediately, and reads its specifier', () => {
    // The exact shape `apps/web/server/runs/acceptance/run-acceptance.mjs` uses. Both halves are
    // asserted: nothing is reported as undecidable, *and* the module it names is collected rather
    // than dropped.
    const real = `const bin = createRequire(resolve(webRoot, 'package.json')).resolve('next/dist/bin/next');`;
    const scan = scanModuleSource('fixture.mjs', real);
    expect(scan.undecidable).toEqual([]);
    expect(scan.references.map((reference) => reference.specifier)).toContain('next/dist/bin/next');

    // Importing the name is not a module reference at all, and used to be reported as one.
    const importsIt = `import { createRequire } from 'node:module';`;
    const importScan = scanModuleSource('fixture.mjs', importsIt);
    expect(importScan.undecidable).toEqual([]);
    expect(importScan.references.map((reference) => reference.specifier)).toEqual(['node:module']);
  });

  it('refuses a file it could not parse, rather than reporting what survived error recovery', () => {
    // The control for the `parseDiagnostics` read described beside {@link ParsedSourceFile}. A
    // walk over a tree the parser gave up on finds whatever survived, and calling that "no SDK
    // import" is the fail-open shape ADR-0015 forbids. The first source below is a real syntax
    // error and must be refused; the second parses cleanly and must not be, so the arm is about
    // syntax rather than about every file.
    expect(scanModuleSource('fixture.ts', `import { from ;\nconst x = ;`).undecidable).not.toEqual(
      [],
    );
    expect(scanModuleSource('fixture.ts', `export const x = 1;\n`).undecidable).toEqual([]);
  });

  it('leaves a plain mention of the package name alone', () => {
    const prose = `// see @anthropic-ai/claude-agent-sdk for details\nconst label = '@anthropic-ai/claude-agent-sdk 0.3.258';`;
    const scan = scanModuleSource('fixture.ts', prose);
    expect(scan.references).toEqual([]);
    expect(scan.undecidable).toEqual([]);
  });
});

describe('the call-site classifier decides every call, not the ones it has names for', () => {
  // ADR-0031 clause 1, and the round-4 finding it answers. The version this replaced chose which
  // call sites to examine from RESOLVER_CALLS, OPAQUE_CALLS and OPAQUE_PROPERTIES, and a callee in
  // none of the three fell out of the branch with no `else` — neither collected nor refused. Four
  // real node module loaders were outside the tables, each proved by running node and watching the
  // SDK load, and each left the gate green.
  const LOADERS_A_VERIFIER_RAN: ReadonlyArray<readonly [string, string]> = [
    ['module.require', `const m = module.require('@anthropic-ai/claude-agent-sdk');`],
    ['require.main.require', `const m = require.main.require('@anthropic-ai/claude-agent-sdk');`],
    [
      'process.mainModule.require',
      `const m = process.mainModule.require('@anthropic-ai/claude-agent-sdk');`,
    ],
    ['load', `const load = require;\nconst m = load('@anthropic-ai/claude-agent-sdk');`],
  ];

  it.each(LOADERS_A_VERIFIER_RAN)(
    'refuses %s, and does so without holding its name anywhere',
    (callee, source) => {
      // Both halves matter, and the second is the one that makes this a different gate rather
      // than a longer table: the callee is refused *and* no table in this file mentions it. If a
      // later repair answers a new spelling by adding it to a table, this assertion goes red and
      // says so.
      const scan = scanModuleSource('fixture.ts', source);
      expect(scan.undecidable, `${callee} was not refused`).not.toEqual([]);
      for (const table of [RESOLVER_CALLS, OPAQUE_CALLS, OPAQUE_PROPERTIES]) {
        expect(
          [...table],
          `${callee} is refused because this file learned its name, which is the enumeration ADR-0031 forbids`,
        ).not.toContain(callee);
      }
    },
  );

  it('refuses four constructs nobody has run at it, including one rooted at no name', () => {
    // The point of the classifier: it does not need to have seen a spelling. The first three were
    // each written into a tracked `.cjs` under `apps/runner/src/` and run — `node <file>` printed
    // `query is a function` for all three, so all three really do load the SDK — and none of their
    // callees is named anywhere in this file.
    const loadTheSdkUnderNode = [
      `const m = Reflect.apply(module.require, module, ['@anthropic-ai/claude-agent-sdk']);`,
      `const spec = '@anthropic-ai/claude-agent-sdk';\nconst m = require('node:module')._load(spec, module, false);`,
      `const m = globalThis.process.mainModule.require('@anthropic-ai/claude-agent-sdk');`,
    ];
    // The fourth is refused for a different reason and is *not* a working loader: detaching
    // `module.require` from its receiver makes node throw `MODULE_NOT_FOUND`, which is what
    // running it printed. It is here because it is rooted at no identifier at all, which is a
    // shape `calleeRoot` answers `null` for.
    const rootedAtNoName = `const m = (0, module.require)('@anthropic-ai/claude-agent-sdk');`;
    for (const source of [...loadTheSdkUnderNode, rootedAtNoName]) {
      expect(scanModuleSource('fixture.ts', source).undecidable, source).not.toEqual([]);
    }
  });

  it('gives a construction a verdict, on three shapes that each loaded the SDK under node', () => {
    // The round-5 finding. `new` had an arm of its own that recorded no verdict, justified by the
    // claim that "nothing else `new` can be applied to loads a module". `new Worker(path)` does:
    // node resolves and executes the entry module on a thread. All three sources below were written
    // into tracked files in this worktree and run — each printed `exit code 0` with no `error`
    // event, which is the worker having run sdk.mjs to completion — and before this round the gate
    // stayed at 82 passed for all three. (The `online` event is not proof: it fires before the
    // entry module is resolved.)
    const SDK_FILE =
      './packages/engine-claude-agent-sdk/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
    const freeWorker = `new (require('node:worker_threads').Worker)`;

    // (a) The plain form is a refusal, and it names both the construct and the file.
    const plain = scanModuleSource('fixture.ts', `const w = ${freeWorker}('${SDK_FILE}');`);
    expect(
      plain.undecidable,
      'a `new` handed a resolvable specifier fell out of the branch',
    ).not.toEqual([]);
    expect(plain.undecidable[0]?.reason).toContain('Worker');
    expect(plain.undecidable[0]?.reason).toContain(SDK_FILE);
    // The second half of the pattern, as for every other loader here: the refusal is not this file
    // having learned the name. If a later repair answers `new Worker` by adding it to a table, this
    // goes red and says so.
    for (const table of [RESOLVER_CALLS, OPAQUE_CALLS, OPAQUE_PROPERTIES]) {
      expect(
        [...table],
        'Worker is refused because this file learned its name, which is the enumeration ADR-0031 forbids',
      ).not.toContain('Worker');
    }

    // (b) and (c) are the two shapes the base-URL arm reads, so their verdict is *collected*
    // rather than refused — and what it collects is the SDK, which puts the file in the detected
    // set and fails the §42 assertion. (c) is the ordinary ESM idiom, where the outer callee is
    // bound by the import and so is vouched for; the specifier is inside the nested `new URL`.
    for (const source of [
      `const w = ${freeWorker}('${SDK_FILE}', 'file:///x/');`,
      `import { Worker } from 'node:worker_threads';\nconst w = new Worker(new URL('${SDK_FILE}', import.meta.url));`,
    ]) {
      const scan = scanModuleSource('fixture.ts', source);
      expect(
        scan.references.map((reference) => reference.specifier),
        source,
      ).toContain(SDK_FILE);
    }
  });

  it('reads a reference resolved against a base URL by the pair, not by the callee being URL', () => {
    // The arm that keeps (a) above from refusing the tracked tree. Two real sites have the shape —
    // `readFileSync(new URL('./agent-form.tsx', import.meta.url), 'utf8')` in
    // apps/web/components/agents/agents-screens.test.ts and the `fileURLToPath(new URL(…))` in
    // apps/web/server/runs/store.test.ts — and both were refusals when the `new` arm was first
    // deleted outright. What decides them is the argument pair, which is why the callee's name is
    // not in any table and this assertion says so.
    const named = scanModuleSource(
      'fixture.ts',
      `const url = new URL('./package.json', import.meta.url);`,
    );
    expect(named.undecidable).toEqual([]);
    for (const table of [RESOLVER_CALLS, OPAQUE_CALLS, OPAQUE_PROPERTIES]) {
      expect([...table], 'the base-URL arm is a name after all').not.toContain('URL');
    }
    // A callee this file has never heard of, handed the same pair, is read the same way…
    const unheardOf = scanModuleSource(
      'fixture.ts',
      `const x = new Wibble('./package.json', import.meta.url);`,
    );
    expect(unheardOf.undecidable).toEqual([]);
    expect(unheardOf.references.map((reference) => reference.specifier)).toContain(
      './package.json',
    );
    // …and the same callee without the base URL is refused, so it is the pair doing the work.
    expect(
      scanModuleSource('fixture.ts', `const x = new Wibble('./package.json');`).undecidable,
    ).not.toEqual([]);
    // And the arm is collecting, not exempting: the round-5 verifier's own control — silent before
    // this round on a specifier it demonstrated resolves — now puts its file in the detected set.
    expect(
      scanModuleSource(
        'apps/runner/src/b15.cjs',
        `const u = new globalThis.URL('@anthropic-ai/claude-agent-sdk', 'file:///x/');`,
      ).references.map((reference) => reference.specifier),
    ).toContain(SDK_PACKAGE);
  });

  it('collects every string at a base-URL call, so a later one is not left undecided', () => {
    // The regression the closeout diff introduced, and the shape that must not come back. The arm
    // above collected the first resolvable string and then *returned*, so at a call carrying a
    // base URL every later string — the SDK included — fell out of the loop with no verdict. A
    // tracked repo-root `b20.cjs` holding this exact line left the gate at `Tests 85 passed (85)`
    // and named b20.cjs nowhere, while the previous revision of this file
    // (`git checkout 905b1f2 -- tests/no-sdk-import.test.ts`, probe unchanged) refused it by name
    // at `1 failed | 81 passed (82)`. With the arm fixed the same probe fails the §42 set equality
    // naming b20.cjs. The candidate is what the arm decides; the call is only where the base URL
    // is found.
    const several = scanModuleSource(
      'b20.cjs',
      `const q = Wibble('./package.json', 'file:///x/', '@anthropic-ai/claude-agent-sdk');`,
    );
    const collected = several.references.map((reference) => reference.specifier);
    expect(collected, 'the first resolvable string is still collected').toContain('./package.json');
    expect(
      collected,
      'a string after the first at a base-URL call left with no verdict — the arm returned instead of continuing',
    ).toContain(SDK_PACKAGE);
    // The bound, so this is a verdict for each string rather than a claim about the shape: the
    // same line with the SDK *first* was already decided before this patch, which is why the
    // regression was silent on one ordering and loud on the other.
    expect(
      scanModuleSource(
        'b21.cjs',
        `const q = Wibble('@anthropic-ai/claude-agent-sdk', 'file:///x/');`,
      ).references.map((reference) => reference.specifier),
    ).toContain(SDK_PACKAGE);
  });

  it('reads a specifier spread into a call, which is a literal written at the call site', () => {
    // The round-5 major finding. A tracked `apps/runner/src/b5.cjs` holding this line printed
    // `B5 LOADED, query is a function` under node while the gate stayed at 82 passed, and the same
    // array literal one AST node away — in `Reflect.apply` — was refused. Only the `...` changed
    // the verdict, on a specifier written out verbatim at the call site.
    const spread = scanModuleSource(
      'fixture.ts',
      `const m = module.require(...['@anthropic-ai/claude-agent-sdk']);`,
    );
    expect(spread.undecidable, 'a spread hides nothing: the literal is written here').not.toEqual(
      [],
    );
    expect(spread.undecidable[0]?.reason).toContain(SDK_PACKAGE);
    // The sibling it was measured against, still refused.
    expect(
      scanModuleSource(
        'fixture.ts',
        `const m = Reflect.apply(module.require, module, ['@anthropic-ai/claude-agent-sdk']);`,
      ).undecidable,
    ).not.toEqual([]);
    // …and the bound on it, so the limit is visible rather than claimed: a spread of a *name* is
    // not read, because the one step of value tracking ends at a literal. That is the declared
    // computed-specifier gap reaching this arm too, not a second silent path.
    expect(
      scanModuleSource(
        'fixture.ts',
        `const parts = ['@anthropic-ai/claude-agent-sdk'];\nconst m = module.require(...parts);`,
      ).undecidable,
      'this is the declared gap; if it is now refused, update the header',
    ).toEqual([]);
  });

  it('names the file and the construct it could not decide', () => {
    // Clause 1 asks for both, because "something in this repository is undecidable" is not a
    // report anyone can act on.
    const scan = scanModuleSource(
      'apps/runner/src/door.cjs',
      `const m = module.require('@anthropic-ai/claude-agent-sdk');`,
    );
    const first = scan.undecidable[0];
    expect(first?.file).toBe('apps/runner/src/door.cjs');
    expect(first?.reason).toContain('module.require');
    expect(first?.reason).toContain('@anthropic-ai/claude-agent-sdk');
  });

  it('leaves the ordinary calls this repository is made of alone', () => {
    // The other direction, and the reason the classifier asks what a call is *handed* rather than
    // what it is called: a rule that refused every callee it could not name would refuse most of
    // the tree. Each of these is a shape the tracked tree really contains, written with the
    // binding the real file gives it — which is the whole of why they are decided rather than
    // refused, and why the second one goes red without its `import`.
    const ordinary = [
      `console.log('@anthropic-ai/claude-agent-sdk is confined to one module');`,
      `import path from 'node:path';\nconst joined = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');`,
      `import { describe } from 'vitest';\ndescribe('@agent-workspace/core', () => {});`,
      `const url = new URL('./package.json', import.meta.url);`,
      `import { expect } from 'vitest';\nexpect(name).toBe('@anthropic-ai/claude-agent-sdk');`,
    ];
    for (const source of ordinary) {
      expect(scanModuleSource('fixture.ts', source).undecidable, source).toEqual([]);
    }
    // The `new URL` row is decided by the base-URL arm — the reference is *collected*, not passed
    // over — and `./package.json` really does resolve from this fixture's directory, so that row is
    // not passing because the string named nothing. Both halves, because the round before this one
    // had that row passing for a reason that was false.
    expect(stringNamesAModule('fixture.ts', './package.json')).not.toBeNull();
    expect(
      scanModuleSource(
        'fixture.ts',
        `const url = new URL('./package.json', import.meta.url);`,
      ).references.map((reference) => reference.specifier),
    ).toContain('./package.json');
    // …and the sentence in the comment above, run rather than asserted from memory: the same
    // `path.join` line without the import that binds `path` is refused.
    expect(
      scanModuleSource(
        'fixture.ts',
        `const joined = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');`,
      ).undecidable,
    ).not.toEqual([]);
  });

  it('reads a specifier the file lifted into a const, and refuses to guess at one bound twice', () => {
    // The single step of value-tracking, asserted in both directions. A name bound once by `const`
    // to a literal is that literal; a name bound more than once is dropped rather than guessed,
    // which is why the second source below reports no reference to the SDK at all.
    const once = scanModuleSource(
      'fixture.ts',
      `const spec = '@anthropic-ai/claude-agent-sdk';\nconst m = require(spec);`,
    );
    expect(once.undecidable).toEqual([]);
    expect(once.references.map((reference) => reference.specifier)).toContain(SDK_PACKAGE);

    const twice = scanModuleSource(
      'fixture.ts',
      `const spec = '@anthropic-ai/claude-agent-sdk';\nfunction other() {\n  const spec = 'node:fs';\n  return spec;\n}\nconst m = require(spec);`,
    );
    expect(twice.references.map((reference) => reference.specifier)).not.toContain(SDK_PACKAGE);
    expect(
      twice.undecidable,
      'a specifier this gate cannot read is a refusal, not a pass',
    ).not.toEqual([]);
  });
});

describe("where this gate's reach ends", () => {
  // ADR-0031 clause 2. Every sentence of the header's limits section is one of these assertions.
  // They are written as demonstrations of the gap rather than as prose about it, because prose
  // about a gate's reach is the thing that stops the next reader looking.
  it('refuses eval and Function rather than analysing what they build', () => {
    // The limit that cannot be repaired: a specifier assembled inside a string of source this gate
    // never parses is outside every static analysis, so both constructs are refused whole.
    for (const source of [
      `const m = eval("require('@anthropic-ai/claude-agent-sdk')");`,
      `const build = new Function('s', 'return import(s)');`,
      `const build = Function('s', 'return import(s)');`,
    ]) {
      expect(scanModuleSource('fixture.ts', source).undecidable, source).not.toEqual([]);
    }
    // The refusal is on the written form — `eval(…)`, `Function(…)`, `new Function(…)` — and not on
    // every route to the same function. A copy reached some other way is decided by the classifier
    // on what it is handed, like any other call, which is the declared gap and not a special case.
    expect(scanModuleSource('fixture.ts', `const m = globalThis.eval('x');`).undecidable).toEqual(
      [],
    );
  });

  it('does not see a specifier that arrives through a parameter', () => {
    // Stated as a passing scan, which is what makes it a gap and not a claim. `load` is a
    // parameter, so the callee is rooted at a name this file binds and the classifier vouches for
    // it; the specifier is a literal, but the loader was handed in from outside.
    const scan = scanModuleSource(
      'fixture.ts',
      `export function reach(load) {\n  return load('@anthropic-ai/claude-agent-sdk');\n}`,
    );
    expect(
      scan.undecidable,
      'this is the declared gap; if it is now refused, update the header',
    ).toEqual([]);
    expect(scan.references.map((reference) => reference.specifier)).not.toContain(SDK_PACKAGE);
    // …and the call that hands the loader in is not refused either. `module.require` written in a
    // non-call position is a property access, and this gate refuses those only for the two entries
    // in OPAQUE_PROPERTIES. Both halves of the gap, so a reader can see the whole of it.
    expect(scanModuleSource('fixture.ts', `reach(module.require);`).undecidable).toEqual([]);
  });

  it('does not see a specifier that arrives out of a computation', () => {
    // The same limit on the argument rather than the callee: the gate reads a literal and a const
    // bound to one, and nothing else.
    const scan = scanModuleSource(
      'fixture.ts',
      `const parts = ['@anthropic-ai', 'claude-agent-sdk'];\nconst m = module.require(parts.join('/'));`,
    );
    expect(
      scan.undecidable,
      'this is the declared gap; if it is now refused, update the header',
    ).toEqual([]);
    // …and the bound on it: the same computed specifier handed to a callee this gate *does* read a
    // specifier from is still a hard refusal, and has been since the resolver conversion. The gap
    // needs an unrecognised loader and an assembled specifier together.
    expect(
      scanModuleSource('fixture.ts', `const m = require(parts.join('/'));`).undecidable,
    ).not.toEqual([]);
  });

  it('binds names over the whole file rather than by scope', () => {
    // The third limit, and the least obvious. `module` is bound inside `shadow` and nowhere else,
    // yet the call outside it is vouched for, because the binding set is per-file. A scope-accurate
    // binder would refuse this; this gate does not have one.
    const scan = scanModuleSource(
      'fixture.ts',
      `function shadow(module) {\n  return module;\n}\nconst m = module.require('@anthropic-ai/claude-agent-sdk');`,
    );
    expect(
      scan.undecidable,
      'this is the declared gap; if it is now refused, update the header',
    ).toEqual([]);
    // …and the control that keeps the sentence about scope rather than about `module`: with no
    // such binding anywhere in the file, the identical call is refused.
    expect(
      scanModuleSource('fixture.ts', `const m = module.require('@anthropic-ai/claude-agent-sdk');`)
        .undecidable,
    ).not.toEqual([]);
  });
});

describe('a reference is decided by resolving it, not by reading its text', () => {
  it('resolves the SDK to a file its own package.json claims, so the comparison is not a name', () => {
    // ADR-0015 on the resolver itself: every §42 assertion is "this resolved path belongs to the
    // SDK", and all of them pass vacuously if the SDK stops resolving or if `owningPackageName`
    // stops answering. Both halves are asserted here against the installed package.
    const resolution = resolveSpecifier(path.join(REPO_ROOT, SDK_BOUNDARY), SDK_PACKAGE);
    expect(resolution.kind, `${SDK_PACKAGE} did not resolve from ${SDK_BOUNDARY}`).toBe('resolved');
    if (resolution.kind !== 'resolved') return;
    expect(isFile(resolution.file), `${resolution.file} is not a file on disk`).toBe(true);
    expect(owningPackageName(resolution.file)).toBe(SDK_PACKAGE);
    expect(sdkOwns(resolution.file)).toBe(true);
    // …and a file in this repository is not the SDK, which is what makes the check a comparison
    // of packages rather than a function that says yes.
    expect(sdkOwns(path.join(REPO_ROOT, SDK_BOUNDARY))).toBe(false);
  });

  it('honours a paths alias declared in the project that owns the importing file', () => {
    // `apps/web/tsconfig.json` really does map `@/*`, and `apps/web` really does import through
    // it. Nothing in this file knows that: the alias is applied by `ts.resolveModuleName`.
    const importer = path.join(REPO_ROOT, 'apps/web/app/api/runs/[id]/route.ts');
    const resolution = resolveSpecifier(importer, '@/server/runs/api');
    expect(resolution.kind).toBe('resolved');
    if (resolution.kind !== 'resolved') return;
    expect(resolution.file).toBe(realPath(path.join(REPO_ROOT, 'apps/web/server/runs/api.ts')));
    // The same specifier written from a project with no such alias resolves to nothing, so the
    // assertion above is about the project's configuration and not about the text `@/`.
    expect(resolveSpecifier(path.join(REPO_ROOT, SDK_BOUNDARY), '@/server/runs/api').kind).toBe(
      'unresolved',
    );
  });

  it('honours a baseUrl and a paths block reached through an extends of any filename', () => {
    // The two resolution roots the alias table this replaced did not model. Neither is written
    // out here as a rule: each project below is handed to the compiler, and the compiler answers.
    const root = mkdtempSync(path.join(os.tmpdir(), 'w2-int-01-resolution-'));
    try {
      // (a) `baseUrl` alone. No `paths` entry exists anywhere in this project, and a bare
      //     specifier still resolves, because `baseUrl` is a resolution root in its own right.
      const byBaseUrl = path.join(root, 'by-base-url');
      mkdirSync(path.join(byBaseUrl, 'roots', 'probes'), { recursive: true });
      mkdirSync(path.join(byBaseUrl, 'src'), { recursive: true });
      writeFileSync(path.join(byBaseUrl, 'roots', 'probes', 'target.ts'), 'export const x = 1;\n');
      writeFileSync(
        path.join(byBaseUrl, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: { module: 'esnext', moduleResolution: 'bundler', baseUrl: './roots' },
        }),
      );
      const baseUrlImporter = path.join(byBaseUrl, 'src', 'app.ts');
      writeFileSync(baseUrlImporter, 'export {};\n');
      const viaBaseUrl = resolveSpecifier(baseUrlImporter, 'probes/target');
      expect(viaBaseUrl.kind, 'a baseUrl root did not resolve a bare specifier').toBe('resolved');
      if (viaBaseUrl.kind === 'resolved') {
        expect(viaBaseUrl.file).toBe(
          realPath(path.join(byBaseUrl, 'roots', 'probes', 'target.ts')),
        );
      }

      // (b) a `paths` block in an `extends` target whose extension is not `.json`. `tsc` loads
      //     that file verbatim; a gate that only opened files called `tsconfig*.json` never saw
      //     the table.
      const byExtends = path.join(root, 'by-extends');
      mkdirSync(path.join(byExtends, 'roots', 'probes'), { recursive: true });
      mkdirSync(path.join(byExtends, 'src'), { recursive: true });
      writeFileSync(path.join(byExtends, 'roots', 'probes', 'target.ts'), 'export const x = 1;\n');
      writeFileSync(
        path.join(byExtends, 'shared.base'),
        JSON.stringify({ compilerOptions: { paths: { '@probe/*': ['./roots/probes/*'] } } }),
      );
      writeFileSync(
        path.join(byExtends, 'tsconfig.json'),
        JSON.stringify({
          extends: './shared.base',
          compilerOptions: { module: 'esnext', moduleResolution: 'bundler' },
        }),
      );
      const extendsImporter = path.join(byExtends, 'src', 'app.ts');
      writeFileSync(extendsImporter, 'export {};\n');
      const viaExtends = resolveSpecifier(extendsImporter, '@probe/target');
      expect(viaExtends.kind, 'a paths block in a non-.json extends target did not resolve').toBe(
        'resolved',
      );
      if (viaExtends.kind === 'resolved') {
        expect(viaExtends.file).toBe(
          realPath(path.join(byExtends, 'roots', 'probes', 'target.ts')),
        );
      }

      // …and the negative that makes both of those about the configuration: the same two
      // specifiers, in a project that declares neither root, resolve to nothing.
      const plain = path.join(root, 'plain');
      mkdirSync(path.join(plain, 'src'), { recursive: true });
      writeFileSync(
        path.join(plain, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { module: 'esnext', moduleResolution: 'bundler' } }),
      );
      const plainImporter = path.join(plain, 'src', 'app.ts');
      writeFileSync(plainImporter, 'export {};\n');
      expect(resolveSpecifier(plainImporter, 'probes/target').kind).toBe('unresolved');
      expect(resolveSpecifier(plainImporter, '@probe/target').kind).toBe('unresolved');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a specifier no resolver could place, naming the reference', () => {
    // ADR-0030 clause 3. This is the branch a resolver leaves open, and it is a refusal rather
    // than a skip: the specifier below is syntactically fine and points at nothing.
    expect(
      resolveSpecifier(path.join(REPO_ROOT, SDK_BOUNDARY), './there-is-no-such-module.js').kind,
    ).toBe('unresolved');
  });

  it('follows a symlink to the same file the pnpm store holds', () => {
    // Why every answer goes through `realpathSync`. `apps/runner/node_modules/@anthropic-ai/…` is
    // a link into the content-addressed store, and a reference through the link and a reference
    // through the store are the same module. Comparing the two spellings as text says otherwise.
    const linked = path.join(
      REPO_ROOT,
      'packages/engine-claude-agent-sdk/node_modules',
      SDK_PACKAGE,
      'package.json',
    );
    expect(existsSync(linked), `${linked} is missing, so this control proves nothing`).toBe(true);
    expect(realPath(linked)).not.toBe(path.resolve(linked));
    expect(owningPackageName(realPath(linked))).toBe(SDK_PACKAGE);
  });
});

describe('the shape rule that derives the research-probe permit', () => {
  // The classifier is exercised on names directly, so the assertions over the shipped tree
  // cannot pass because the rule stopped deciding. Every arm, including both rejections.
  it('recognises a runnable probe', () => {
    expect(classifyResearchFixture(`${RESEARCH_FIXTURE_ROOT}/r-06/probe-1.mjs`).kind).toBe('probe');
    expect(classifyResearchFixture(`${RESEARCH_FIXTURE_ROOT}/r-06/probe-1.mjs.example`).kind).toBe(
      'probe',
    );
  });

  it('recognises an inert capture, which needs no permit', () => {
    expect(classifyResearchFixture(`${RESEARCH_FIXTURE_ROOT}/r-06/README.md`).kind).toBe('capture');
    expect(classifyResearchFixture(`${RESEARCH_FIXTURE_ROOT}/r-06/stream.json`).kind).toBe(
      'capture',
    );
    expect(classifyResearchFixture(`${RESEARCH_FIXTURE_ROOT}/r-06/.gitkeep`).kind).toBe('capture');
  });

  it('rejects module source that is not a runnable probe, by name', () => {
    // The case that must not be a silent drop: a `.ts` beside the probes is module source this
    // gate scans, so leaving it out of the permit quietly would make it an unexplained offender.
    const verdict = classifyResearchFixture(`${RESEARCH_FIXTURE_ROOT}/r-06/probe.ts`);
    expect(verdict.kind).toBe('unrecognised');
    expect(verdict.kind === 'unrecognised' ? verdict.reason : '').toContain('.mjs');
  });

  it('rejects a kind nobody has decided about, rather than defaulting it either way', () => {
    // Markup can name a module through `src`/`href`, so it is neither a probe nor a capture,
    // and an extension no table knows is the fall-through ADR-0015 asks for.
    expect(classifyResearchFixture(`${RESEARCH_FIXTURE_ROOT}/r-06/page.html`).kind).toBe(
      'unrecognised',
    );
    expect(classifyResearchFixture(`${RESEARCH_FIXTURE_ROOT}/r-06/capture.unitfile`).kind).toBe(
      'unrecognised',
    );
  });

  it('detects product code that resolves into the fixture tree, by whatever route', () => {
    // The positive control for the consumer assertion below, which is otherwise a `toEqual([])`
    // that a broken walk would satisfy. Both a relative specifier and a bare one through the
    // `@/` alias `apps/web/tsconfig.json` really declares — and the alias case is decided by the
    // compiler, which is the whole conversion in one line.
    const importer = path.join(REPO_ROOT, 'apps/web/app/api/runs/[id]/route.ts');
    const probe = `${RESEARCH_FIXTURE_ROOT}/agent-sdk/probe-1-session-store.mjs`;
    const relative = resolveSpecifier(importer, `../../../../../../${probe}`);
    expect(relative.kind).toBe('resolved');
    expect(relative.kind === 'resolved' && insideResearchFixtures(relative.file)).toBe(true);
    // `@/*` maps onto `apps/web/*`, so a specifier that climbs out of it lands in the fixture
    // tree without spelling an alias target anywhere. Nothing here expands `@/` — the compiler
    // does, which is why the same shape defeated the table this replaced.
    const aliased = resolveSpecifier(importer, `@/../../${probe}`);
    expect(aliased.kind).toBe('resolved');
    expect(aliased.kind === 'resolved' && insideResearchFixtures(aliased.file)).toBe(true);
    // …and the negative that keeps it about the fixture tree rather than about the word `docs`.
    const elsewhere = resolveSpecifier(importer, '@/server/runs/api');
    expect(elsewhere.kind === 'resolved' && insideResearchFixtures(elsewhere.file)).toBe(false);
  });
});

describe('an unresolvable bare specifier in a fixture is a classified verdict, not a refusal', () => {
  // ADR-0032, one assertion per clause, each written as something that runs rather than as prose.
  // The fixture paths here are constructed rather than committed — the same way the shape rule
  // above is exercised — so nothing plants a file under a tree a parallel worker is walking
  // (ADR-0019 clause 4), and no committed fixture or README is edited to prove a red.
  const FIXTURE = `${RESEARCH_FIXTURE_ROOT}/r-06/probe.mjs`;
  const OUTSIDE = 'apps/runner/src/probe.mjs';
  const MCP = '@modelcontextprotocol/sdk/client/stdio.js';

  const readme = (text: string): FixtureReadme => ({
    file: `${RESEARCH_FIXTURE_ROOT}/r-06/README.md`,
    text,
  });
  /** A README shaped like the real one: an install line that names the package. */
  const DOCUMENTS_IT = readme(
    'npm init -y && npm install @anthropic-ai/claude-agent-sdk@0.3.258 @modelcontextprotocol/sdk@1.30.0\n',
  );
  /** The same README with the package name taken out, which is the clause-3 red proof. */
  const DOCUMENTS_NOTHING = readme(
    'npm init -y && npm install @anthropic-ai/claude-agent-sdk@0.3.258\n',
  );
  const reference = (specifier: string): ModuleReference => ({
    specifier,
    form: 'an import declaration',
  });

  it('classifies a bare specifier whose package the fixture README names', () => {
    // Clause 1: a named verdict carrying the package and the README it rests on — never a skip.
    const verdict = decideUnresolvedReference(FIXTURE, reference(MCP), () => DOCUMENTS_IT);
    expect(verdict.kind).toBe('undeclared-package');
    expect(verdict.kind === 'undeclared-package' ? verdict.packageName : '').toBe(
      '@modelcontextprotocol/sdk',
    );
    expect(verdict.kind === 'undeclared-package' ? verdict.readme : '').toBe(
      `${RESEARCH_FIXTURE_ROOT}/r-06/README.md`,
    );
    // …and the same specifier written outside the fixture tree is still refused, so the verdict is
    // about where the file is and not about the package's name.
    const outside = decideUnresolvedReference(OUTSIDE, reference(MCP), () => DOCUMENTS_IT);
    expect(outside.kind).toBe('refused');
  });

  it('refuses a relative specifier that resolves nowhere, fixtures included', () => {
    // Clause 2, run end to end on a fixture path: the walk finds the reference, the compiler
    // places it nowhere, and the verdict is a refusal even though the README beside it documents a
    // package. A relative reference names a file this repository contains; one that resolves to
    // nothing is a broken link, and no installation elsewhere explains it.
    const scan = scanModuleSource(FIXTURE, `import './no-such-sibling.mjs';`);
    expect(
      scan.undecidable,
      'the reference itself is readable; only its target is missing',
    ).toEqual([]);
    const found = scan.references[0];
    expect(found?.specifier).toBe('./no-such-sibling.mjs');
    expect(resolveSpecifier(path.join(REPO_ROOT, FIXTURE), './no-such-sibling.mjs').kind).toBe(
      'unresolved',
    );
    const verdict = decideUnresolvedReference(
      FIXTURE,
      reference('./no-such-sibling.mjs'),
      () => DOCUMENTS_IT,
    );
    expect(verdict.kind, 'a broken relative import inside a fixture is still a hard failure').toBe(
      'refused',
    );
    expect(verdict.kind === 'refused' ? verdict.reason : '').toContain('ADR-0032 clause 2');
    // The two other shapes that are not packages either, for the same reason.
    for (const specifier of ['../../elsewhere/gone.mjs', '#internal/missing']) {
      expect(
        decideUnresolvedReference(FIXTURE, reference(specifier), () => DOCUMENTS_IT).kind,
        specifier,
      ).toBe('refused');
    }
  });

  it('refuses when the fixture README does not name the package', () => {
    // Clause 3, and this is the assertion that stops the verdict becoming a hole. The only
    // difference between this and the passing case above is the README text: the package name is
    // taken out of a copy, and the verdict goes from a classification to a refusal that says which
    // file to write it into.
    const verdict = decideUnresolvedReference(FIXTURE, reference(MCP), () => DOCUMENTS_NOTHING);
    expect(verdict.kind).toBe('refused');
    const reason = verdict.kind === 'refused' ? verdict.reason : '';
    expect(reason).toContain('@modelcontextprotocol/sdk');
    expect(reason).toContain(`${RESEARCH_FIXTURE_ROOT}/r-06/README.md`);
    expect(reason).toContain('ADR-0032 clause 3');

    // …and a fixture no README covers at all is refused rather than classified, because there is
    // then nothing for the verdict to rest on.
    const uncovered = decideUnresolvedReference(FIXTURE, reference(MCP), () => null);
    expect(uncovered.kind).toBe('refused');
    expect(uncovered.kind === 'refused' ? uncovered.reason : '').toContain('ADR-0032 clause 3');
  });

  it('reads a README name as a name, not as a prefix of a longer one', () => {
    // The unit behind clause 3, in both directions. A `includes` would let a README documenting a
    // different package satisfy the clause, which is the fail-open shape it exists to stop.
    expect(
      namesPackage('install @modelcontextprotocol/sdk@1.30.0', '@modelcontextprotocol/sdk'),
    ).toBe(true);
    expect(
      namesPackage('import … from @modelcontextprotocol/sdk/types.js', '@modelcontextprotocol/sdk'),
    ).toBe(true);
    expect(
      namesPackage('install @modelcontextprotocol/sdk-experimental', '@modelcontextprotocol/sdk'),
      'a longer package name documents itself, not this one',
    ).toBe(false);
    expect(
      namesPackage('install vendor/@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk'),
    ).toBe(false);
    expect(namesPackage('nothing here', '@modelcontextprotocol/sdk')).toBe(false);
    // …and the real README, which is what the shipped classification rests on.
    expect(
      namesPackage(
        readTracked(`${RESEARCH_FIXTURE_ROOT}/R-06-mcp/README.md`),
        '@modelcontextprotocol/sdk',
      ),
    ).toBe(true);
  });

  it('reads a package name off a bare specifier and nothing else off anything else', () => {
    expect(packageNameOf('@modelcontextprotocol/sdk/client/stdio.js')).toBe(
      '@modelcontextprotocol/sdk',
    );
    expect(packageNameOf('@modelcontextprotocol/sdk')).toBe('@modelcontextprotocol/sdk');
    expect(packageNameOf('express/lib/router')).toBe('express');
    expect(packageNameOf('express')).toBe('express');
    // Every arm that must answer `null`, so the refusal is by rule rather than by fall-through.
    for (const specifier of [
      '',
      './sibling.mjs',
      '../up.mjs',
      '#internal/missing',
      '/absolute/path.mjs',
      'node:fs',
      'https://cdn.example.invalid/x.mjs',
      '@scope-with-no-name',
    ]) {
      expect(packageNameOf(specifier), specifier).toBeNull();
    }
  });

  it('reads the README that really covers the R-06 probes, from the tracked tree', () => {
    // The lookup, asserted against the shipped tree rather than a stub: without this the three
    // assertions above are about a function nothing calls with real arguments.
    const found = researchFixtureReadme(`${RESEARCH_FIXTURE_ROOT}/R-06-mcp/probe-wire.mjs`);
    expect(found?.file).toBe(`${RESEARCH_FIXTURE_ROOT}/R-06-mcp/README.md`);
    expect(found?.text).toContain('npm install');
    // …and the search stops at the fixture root rather than climbing out of it into `docs/`.
    expect(researchFixtureReadme('docs/research/README.md')).toBeNull();
  });
});

describe(`spec §42 — one file reaches the SDK`, () => {
  it('is reached, outside the research fixtures, by exactly the boundary file', () => {
    // A set equality, not "no offenders": see this file's header. The message on a failure is
    // the diff between these two arrays, which names both a new importer and a lost one, and
    // this is the assertion that closes the vacuity for the whole gate — it cannot pass on a
    // scan that found nothing, because `SDK_BOUNDARY` has to be in the result.
    //
    // It is stated over the tree *outside* `RESEARCH_FIXTURE_ROOT` because a probe is permitted
    // to import the SDK, not obliged to: `extract-options.mjs` is a committed probe that reads
    // a `.d.ts` and imports only `node:fs`. The literal list this replaced could not express
    // that — it named the three probes that did import, so it was a list of *actual importers*
    // wearing the name of a permit, and every new probe that imported the SDK made it wrong.
    const outsideFixtures = importers.filter((file) => !isResearchFixture(file));
    expect(
      outsideFixtures,
      `permitted set was: ${PERMITTED.join(', ')}. ` +
        `Every reference that put a file in the detected set, as specifier -> resolved path: ` +
        detectedEdges.join(' | '),
    ).toEqual(SDK_BOUNDARY_FILES);
  });

  it('is reached, inside the research fixtures, by nothing that is not a derived probe', () => {
    // The other half. Not vacuous with the above: an SDK-importing `.js` dropped beside the
    // probes is `unrecognised`, so it is *not* in the permitted set, and it fails here by name
    // as well as in the classifier assertion — the safe direction described where the permit is
    // derived.
    const insideFixtures = importers.filter(isResearchFixture);
    expect(
      insideFixtures.filter((file) => !researchProbes.includes(file)),
      `SDK importers under ${RESEARCH_FIXTURE_ROOT}/ that the shape rule did not recognise as probes; derived probes were: ${researchProbes.join(', ')}`,
    ).toEqual([]);
    // And the permit is not theoretical: the probes that do import the SDK are seen doing it.
    // Without this, the assertion above passes on a walk that resolved nothing at all under
    // `docs/` — which is what happens if the fallback described in the header is removed, since
    // the SDK is installed for `apps/runner` and for nothing else.
    expect(
      insideFixtures,
      `no committed probe was detected importing the SDK, so the assertion above is quantified over an empty set; derived probes were: ${researchProbes.join(', ')}`,
    ).not.toEqual([]);
  });

  it('permits the fixtures because nothing consumes them, and checks that rather than assuming it', () => {
    // What makes `anything under docs/research/fixtures/` a sound §42 boundary and not simply a
    // wider hole. The permit rests on a probe being evidence a human runs by hand, out of tree.
    // Nothing stops `apps/` from importing one, and a probe that product code imports is product
    // code holding a §42 permit. So the import direction is checked here, and this is the
    // assertion to read first if the boundary is ever widened.
    expect(
      fixtureConsumers,
      `files outside ${RESEARCH_FIXTURE_ROOT}/ that resolve to a module inside it: a probe they ` +
        `import is not evidence any more, it is a dependency with an SDK permit. Every reference ` +
        `that put a file in the detected set, as specifier -> resolved path: ` +
        detectedEdges.join(' | '),
    ).toEqual([]);
  });

  it('is declared as a dependency by exactly one package', () => {
    // The complement of the import rule. A second workspace member that declared the SDK would
    // pass the import assertion until the day someone used it, and by then the dependency would
    // read as established. `apps/runner` owns it because `apps/runner/src/claude.ts` is the only
    // importer; the version is pinned exactly, because R-01 §1 records that this SDK ships
    // breaking changes inside 0.3.x patch releases.
    //
    // These four fields are the ones a package manager installs a dependency from.
    // `bundleDependencies` (an array of names), `overrides` and `resolutions` are deliberately
    // not among them; the pull-request body's ADR-0028 enumeration carries the reason.
    const blocks = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
    const declaring: string[] = [];
    // The runtime bundle is held to its own, narrower rule by the test after this one.
    for (const manifest of packageManifests.filter((f) => f !== RUNTIME_BUNDLE_MANIFEST)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readTracked(manifest)) as unknown;
      } catch (error) {
        throw new Error(
          `${manifest} could not be parsed, so its dependencies cannot be read by this gate: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      }
      const pkg = asRecord(parsed);
      if (pkg === null) {
        throw new Error(`${manifest} is not a JSON object, so its dependencies cannot be read.`);
      }
      for (const block of blocks) {
        const value = asRecord(pkg[block]);
        if (value === null) continue;
        // The own keys are lifted into a local before the package name is compared against them.
        // `Object.prototype.hasOwnProperty.call(value, SDK_PACKAGE)` says the same thing and is
        // refused by this file's own call-site classifier: it hands a string that resolves to the
        // SDK to a callee rooted at `Object`, which no binding in this file explains. That refusal
        // is the classifier working, not a false alarm to be excluded — so the call is written a
        // way the gate can decide. `Object.keys` returns own enumerable keys, which is what the
        // four dependency blocks hold.
        const declaredNames = Object.keys(value);
        for (const row of ENGINE_SDK_BOUNDARIES) {
          if (declaredNames.includes(row.sdkPackage)) declaring.push(manifest);
        }
      }
    }
    expect([...new Set(declaring)].sort((a, b) => a.localeCompare(b))).toEqual(
      [...new Set(ENGINE_SDK_BOUNDARIES.map((row) => row.manifest))].sort((a, b) =>
        a.localeCompare(b),
      ),
    );
  });

  it('is declared by the runtime bundle only as the owning engine pins it', () => {
    // The exception above, held narrow. Without the first assertion a renamed or deleted bundle
    // manifest would leave an exception that excuses nothing and checks nothing.
    expect(packageManifests).toContain(RUNTIME_BUNDLE_MANIFEST);
    const readManifest = (manifest: string): Record<string, unknown> => {
      const record = asRecord(JSON.parse(readTracked(manifest)) as unknown);
      if (record === null) throw new Error(`${manifest} is not a JSON object.`);
      return record;
    };
    const bundle = readManifest(RUNTIME_BUNDLE_MANIFEST);
    expect(bundle['name']).toBe('@indx-workspace/embedded');
    expect(bundle['exports']).toEqual({
      './launch': './dist/bin.js',
      './package.json': './package.json',
    });
    const confined = [...SDK_PACKAGES];
    for (const block of ['devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const names = Object.keys(asRecord(bundle[block]) ?? {});
      expect(
        names.filter((name) => confined.includes(name)),
        `${RUNTIME_BUNDLE_MANIFEST} ${block}`,
      ).toEqual([]);
    }
    const bundleDependencies = asRecord(bundle['dependencies']) ?? {};
    const mismatched: string[] = [];
    for (const row of ENGINE_SDK_BOUNDARIES) {
      if (!Object.keys(bundleDependencies).includes(row.sdkPackage)) continue;
      const ownerPin = asRecord(readManifest(row.manifest)['dependencies'])?.[row.sdkPackage];
      const bundlePin = bundleDependencies[row.sdkPackage];
      if (typeof ownerPin !== 'string' || bundlePin !== ownerPin) {
        mismatched.push(
          `${row.sdkPackage}: ${String(bundlePin)} here, ${String(ownerPin)} in ${row.manifest}`,
        );
      }
    }
    expect(mismatched).toEqual([]);
  });

  it('is not reachable through an HTML import map', () => {
    // An import map is a resolution table for a browser, and this gate resolves markup references
    // as plain URLs. None exists today; if one is added, it must be read here before this
    // assertion is relaxed.
    const withImportMaps = tracked
      .filter((f) => classified.get(f) === 'markup')
      .filter((f) => readTracked(f).includes('importmap'));
    expect(withImportMaps).toEqual([]);
  });
});

// ── 7. The type that travels in the .d.ts ────────────────────────────────────────────────

/**
 * What one file in the declaration emit is.
 *
 *   * `declaration` — a `.d.ts`, `.d.mts` or `.d.cts`. All three carry exported signatures, so
 *     all three can carry an SDK type out of the boundary; the walk this replaced tested
 *     `endsWith('.d.ts')` and silently dropped the other two, which is the ADR-0027 clause 3
 *     shape wearing a directory walk.
 *   * `declaration-map` — the `.map` written beside one when `declarationMap` is on. It holds
 *     positions into the source, not module specifiers.
 *
 * There is no third arm and no default: a file in the emit directory that is neither is
 * `unrecognised`, and the assertion below is that no such file was emitted. A declaration this
 * gate does not read is an SDK type it cannot see leaving.
 */
type EmittedKind = 'declaration' | 'declaration-map' | 'unrecognised';

function classifyEmitted(name: string): EmittedKind {
  if (/\.d\.(?:ts|mts|cts)$/.test(name)) return 'declaration';
  if (/\.d\.(?:ts|mts|cts)\.map$/.test(name)) return 'declaration-map';
  return 'unrecognised';
}

type EmittedFile = { readonly name: string; readonly kind: EmittedKind; readonly text: string };

/** Every file under the emit directory, classified, as repo-relative-looking paths. */
function emittedFiles(dir: string, prefix = ''): EmittedFile[] {
  const out: EmittedFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...emittedFiles(child, `${prefix}${entry.name}/`));
      continue;
    }
    const kind = classifyEmitted(entry.name);
    out.push({
      name: `${prefix}${entry.name}`,
      kind,
      text: kind === 'declaration' ? readFileSync(child, 'utf8') : '',
    });
  }
  return out;
}

describe('spec §42 — the SDK stops at the boundary in the type system too', () => {
  it('classifies every file a declaration emit can contain, and rejects the rest', () => {
    // `.d.mts` and `.d.cts` are declarations the previous `endsWith('.d.ts')` walk dropped in
    // silence; a `.tsbuildinfo` is the shape that must be reported rather than ignored.
    expect(classifyEmitted('claude.d.ts')).toBe('declaration');
    expect(classifyEmitted('claude.d.mts')).toBe('declaration');
    expect(classifyEmitted('claude.d.cts')).toBe('declaration');
    expect(classifyEmitted('claude.d.ts.map')).toBe('declaration-map');
    expect(classifyEmitted('claude.d.mts.map')).toBe('declaration-map');
    expect(classifyEmitted('tsconfig.tsbuildinfo')).toBe('unrecognised');
    expect(classifyEmitted('claude.js')).toBe('unrecognised');
  });

  /**
   * An `import` statement is not the only way a consumer ends up needing an SDK's declarations.
   * A boundary that imports its SDK privately and then puts `Options` on an exported return type,
   * or the SDK's `SessionStore` on an exported parameter, has moved the import site rather than
   * removed it: `tsc --emitDeclarationOnly` writes that import back into the emitted `.d.ts`, and
   * every consumer of the module needs the package to type-check. The scan above cannot see this,
   * because the offending file's own `import` is allowed. So the emitted declarations are read.
   *
   * ENG-04 (#303): **once per row of {@link ENGINE_SDK_BOUNDARIES}.** A second engine's adapter
   * gets the same check, from the same code, because "the SDK stops at the boundary in the type
   * system too" is a claim about each SDK and not about the first one.
   *
   * The emit lands in a temporary directory, so each declaration's references are resolved from
   * the source file it was emitted for — `<sourceRoot>/<name>` — which is the context whose
   * `package.json` and `tsconfig.json` a consumer of the boundary resolves in.
   */
  it.each(ENGINE_SDK_BOUNDARIES)(
    'emits $engine declarations naming no SDK module',
    (row) => {
      const tsc = path.join(REPO_ROOT, 'node_modules', '@typescript', 'native', 'bin', 'tsc');
      expect(existsSync(tsc), `${tsc} is missing, so this gate could not run`).toBe(true);

      const outDir = mkdtempSync(path.join(os.tmpdir(), 'w1-rn-01-dts-'));
      let tscOutput = '';
      try {
        try {
          execFileSync(
            process.execPath,
            [
              tsc,
              '-p',
              row.emitProject,
              '--noEmit',
              'false',
              '--declaration',
              '--emitDeclarationOnly',
              '--rootDir',
              row.sourceRoot,
              '--outDir',
              outDir,
            ],
            { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe' },
          );
        } catch (error) {
          // A type error still emits declarations (`noEmitOnError` is off), and the assertions
          // below are about what was emitted. The output is kept for the failure message rather
          // than swallowed.
          tscOutput = error instanceof Error ? error.message : String(error);
        }

        const emitted = emittedFiles(outDir);
        // The walk classifies rather than filters, so a file kind nobody has decided about is this
        // failure and not a silent drop.
        expect(
          emitted.filter((file) => file.kind === 'unrecognised').map((file) => file.name),
          'files in the declaration emit that this gate does not know how to read, so it cannot say whether they carry an SDK type out of the boundary',
        ).toEqual([]);
        const declarations = emitted.filter((file) => file.kind === 'declaration');
        const boundary = declarations.find((file) => file.name === row.declarationFile);

        // The gate ran: a declaration file exists and carries the surface this test is about. An
        // empty or truncated emit would otherwise satisfy "contains no SDK specifier" vacuously.
        expect(
          boundary,
          `no ${row.declarationFile} was emitted, so this gate proved nothing. tsc said: ${tscOutput}`,
        ).toBeDefined();
        const text = boundary?.text ?? '';
        for (const exported of row.exportedSurface) {
          expect(text, `${row.declarationFile} does not declare ${exported}`).toContain(exported);
        }

        // The detector is the same one used on the source tree, and it goes red on a declaration
        // file that does leak — asserted here rather than assumed, so this test cannot pass
        // because the walk stopped walking.
        const leaking = `import { type Options } from '${row.sdkPackage}';\nexport declare function f(): Options;\n`;
        expect(sourceReachesSdk(`${row.sourceRoot}/leak-control.d.ts`, leaking)).toBe(true);

        const leaks: string[] = [];
        const unreadable: string[] = [];
        for (const declaration of declarations) {
          const emittedFrom = path.join(REPO_ROOT, row.sourceRoot, declaration.name);
          const scan = scanModuleSource(declaration.name, declaration.text);
          for (const entry of scan.undecidable) {
            unreadable.push(`${declaration.name}: ${entry.reason}`);
          }
          for (const reference of scan.references) {
            const resolution = resolveSpecifier(emittedFrom, reference.specifier);
            if (resolution.kind === 'unresolved') {
              unreadable.push(`${declaration.name}: ${reference.specifier} resolved to nothing`);
              continue;
            }
            if (resolution.kind === 'resolved' && sdkOwns(resolution.file)) {
              leaks.push(declaration.name);
            }
          }
        }
        expect(
          unreadable,
          'references in the declaration emit this gate could not decide, so it cannot say whether they reach the SDK',
        ).toEqual([]);
        expect(
          [...new Set(leaks)],
          'emitted declarations that name the SDK: an SDK type is on an exported signature, so every consumer of this module needs the package to type-check',
        ).toEqual([]);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
