/**
 * The project loader child (issue #452, ADR-0111): evaluates a project's `agents/*.ts` and
 * `surfaces/*.ts` in a process of its own and answers one `loaded` message.
 *
 * - **Node's own stripper.** Each file's types are removed by `module.stripTypeScriptTypes` in
 *   strip mode, so a construct that needs a transform (an `enum`, a `namespace`, a parameter
 *   property) is refused with Node's reason rather than compiled.
 * - **A closed linker.** Each file is a `vm.SourceTextModule`. The linker serves
 *   `@indx-workspace/sdk/define` from this process's own copy and, since ADR-0111's slice-2
 *   amendment (issue #548), a project-relative specifier (`./x`, `../tools/orders`) whose one
 *   `.ts` candidate is a regular file with its real path inside the project root and no
 *   `node_modules` segment below the root. Imported files are built like definitions,
 *   transitively. Every other import is refused by name before any code runs, and no
 *   `importModuleDynamically` is given, so an `import()` fails. Nothing is loaded through
 *   `import()`, `require` or `eval`.
 * - **One instance per real path; a failure stays.** A load keeps one cache keyed by real path,
 *   so a cycle links and two definitions share one instance of a tool. The whole graph is
 *   resolved before anything is linked, and a module that failed to strip, resolve an import,
 *   link or evaluate keeps its problem: every definition that reaches it gets the same code and
 *   details. A refused import keeps the file that made it, so it reads the same in every order.
 * - **Self-contained.** This file imports only `node:*` modules, the SDK's define subpath, and
 *   types (from its siblings and the contracts), and uses only erasable syntax: under the test runner Node runs it
 *   from `src` as it is, and from `dist` once built.
 */
import { realpathSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as vm from 'node:vm';

import type { EngineId } from '@indx-workspace/contracts/engines';
import * as define from '@indx-workspace/sdk/define';

import type {
  ChildProblem,
  EvaluatingMessage,
  LoadedFileInput,
  LoadedMessageInput,
  LoadedToolInput,
  LoadMessage,
} from './protocol.js';

/** The one package specifier a project file may import. */
const DEFINE_SPECIFIER = '@indx-workspace/sdk/define';
const DETAILS_MAX = 64;
const DETAIL_MAX_LENGTH = 2000;
/**
 * Characters a served specifier may not hold: nothing is decoded, no query or fragment, and no
 * colon, which on Windows names an alternate data stream of a file rather than a file.
 */
const FORBIDDEN_CHARACTER = /[%?#\\:]/;
/** The only specifiers resolved as files: `./…` and `../…`. */
const RELATIVE_SPECIFIER = /^\.\.?\//;
const TS_FILE = /\.ts$/;
const PACKAGE_DIRECTORY = 'node_modules';

/** What an import resolves to: the shared define module, or a project file's real path. */
const DEFINE = Symbol('define');
type Edge = string | typeof DEFINE;

/**
 * A module's failure, kept unattributed: a refused import keeps the real path of the file that
 * wrote it (`refusedIn`) and names that file in its details; `answerFor` drops the name only when
 * answering for that very file.
 */
interface Failure {
  readonly problem: ChildProblem;
  readonly refusedIn: string | null;
}

interface Location {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

/** A built module of a load, with the imports the walk resolved for it. */
interface BuiltEntry {
  readonly kind: 'built';
  readonly real: string;
  readonly module: vm.SourceTextModule;
  readonly edges: Map<string, Edge>;
  /** Set once the module, or a module it reaches, failed; it then stays failed for the load. */
  failure: Failure | null;
}

/** A file of a load that could not be stripped or built. */
interface BrokenEntry {
  readonly kind: 'broken';
  readonly real: string;
  readonly failure: Failure;
}

type Entry = BuiltEntry | BrokenEntry;

/** What one load shares between its definitions: the root and the module cache. */
interface LoadContext {
  readonly rootReal: string;
  /** Every file of the load, keyed by real path, so each is instantiated at most once. */
  readonly cache: Map<string, Entry>;
  readonly byModule: Map<vm.Module, BuiltEntry>;
}

/** A refusal this loader makes on purpose, carried to the file's answer as it is. */
class LoadRefusal extends Error {
  readonly problem: ChildProblem;

  constructor(problem: ChildProblem) {
    super(problem.code);
    this.name = 'LoadRefusal';
    this.problem = problem;
  }
}

function refusal(
  code: Extract<ChildProblem, { status: null }>['code'],
  detail: string,
): LoadRefusal {
  return new LoadRefusal({ status: null, code, details: [detail.slice(0, DETAIL_MAX_LENGTH)] });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, DETAIL_MAX_LENGTH);
}

/** A `file:///x.ts:3:9` frame; the file stays a URL until `locationOf` makes it project-relative. */
const FRAME = /(file:\/\/\/[^\s()]+):(\d+):(\d+)/u;

/** `url` as a project-relative path, or `null` outside the root or under `node_modules`. */
function projectFile(rootReal: string, url: string): string | null {
  try {
    const real = realpathSync(fileURLToPath(url));
    const relative = path.relative(rootReal, real);
    if (relative === '' || escapes(relative)) return null;
    const file = rootRelative(rootReal, real);
    // A project module is never under `node_modules`, so that is aw's own code, not the user's.
    const inPackages = file
      .split(path.posix.sep)
      .some((s) => s.toLowerCase() === PACKAGE_DIRECTORY);
    return inPackages ? null : file;
  } catch {
    return null;
  }
}

/**
 * Where the stripper (`file:///x.ts:3` on the first stack line, then the source line and a caret
 * line) or the evaluator (the first `    at ` frame inside the project) says `error` is,
 * project-relative. Undefined when no such place exists.
 */
function locationOf(rootReal: string, error: unknown): Location | undefined {
  if (!(error instanceof Error) || typeof error.stack !== 'string') return undefined;
  const lines = error.stack.split('\n');
  const header = /^(file:\/\/\/.+):(\d+)$/u.exec(lines[0] ?? '');
  if (header?.[1] !== undefined && header[2] !== undefined) {
    const file = projectFile(rootReal, header[1]);
    if (file === null) return undefined;
    const caret = lines.findIndex((line) => /^\s*\^+\s*$/u.test(line));
    return {
      file,
      line: Number(header[2]),
      column: caret < 0 ? 1 : (lines[caret] ?? '').indexOf('^') + 1,
    };
  }
  for (const line of lines) {
    if (!line.startsWith('    at ')) continue;
    const frame = FRAME.exec(line);
    const file = frame?.[1] === undefined ? null : projectFile(rootReal, frame[1]);
    if (file !== null) return { file, line: Number(frame?.[2]), column: Number(frame?.[3]) };
  }
  return undefined;
}

function problemOf(rootReal: string, error: unknown): ChildProblem {
  if (error instanceof LoadRefusal) return error.problem;
  const location = locationOf(rootReal, error);
  const located = location === undefined ? {} : { location };
  if (error instanceof define.DefinitionError) {
    // Located at the project line that called defineAgent() and the like (BH061-046).
    return {
      status: 400,
      code: 'invalid_agent_version',
      details: error.issues
        .slice(0, DETAILS_MAX)
        .map((issue) => `${issue.path}: ${issue.message}`.slice(0, DETAIL_MAX_LENGTH)),
      ...located,
    };
  }
  const code = errorCode(error);
  if (code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
    return {
      status: null,
      code: 'typescript_syntax_unsupported',
      details: [messageOf(error)],
      ...located,
    };
  }
  if (code?.startsWith('ERR_VM_DYNAMIC_IMPORT') === true) {
    return { status: null, code: 'import_refused', details: ['import()'] };
  }
  return { status: null, code: 'module_failed', details: [messageOf(error)], ...located };
}

let sharedDefine: vm.SyntheticModule | undefined;

/**
 * The one module exposing every export of this process's `@indx-workspace/sdk/define`, made on
 * first use, so definitions and the files they import link the same instance.
 */
function defineModule(): vm.SyntheticModule {
  if (sharedDefine !== undefined) return sharedDefine;
  const entries = Object.entries(define);
  const synthetic = new vm.SyntheticModule(
    entries.map(([name]) => name),
    () => {
      for (const [name, value] of entries) synthetic.setExport(name, value);
    },
    { identifier: DEFINE_SPECIFIER },
  );
  sharedDefine = synthetic;
  return synthetic;
}

/** Whether `relative` (from `path.relative`) leaves the directory it is relative to. */
function escapes(relative: string): boolean {
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/** `real` relative to the root, with POSIX separators. */
function rootRelative(rootReal: string, real: string): string {
  return path.relative(rootReal, real).split(path.sep).join(path.posix.sep);
}

/**
 * Resolve one specifier written in the file at `importerReal` (ADR-0111, slice-2 amendment): the
 * define module, the real path of a project file, or `null` when the import is refused.
 */
async function resolveSpecifier(
  specifier: string,
  importerReal: string,
  rootReal: string,
): Promise<Edge | null> {
  if (specifier === DEFINE_SPECIFIER) return DEFINE;
  if (FORBIDDEN_CHARACTER.test(specifier) || !RELATIVE_SPECIFIER.test(specifier)) return null;
  // One candidate, no probing: `.ts` as written, otherwise `.ts` appended to whatever it ends in.
  const candidate = TS_FILE.test(specifier) ? specifier : `${specifier}.ts`;
  let real: string;
  try {
    real = await realpath(path.resolve(path.dirname(importerReal), candidate));
    if (!(await stat(real)).isFile()) return null;
  } catch {
    return null;
  }
  if (!TS_FILE.test(real)) return null;
  const relative = path.relative(rootReal, real);
  if (relative === '' || escapes(relative)) return null;
  // Only the path below the root is tested, so a root that sits in `node_modules` still works.
  const segments = rootRelative(rootReal, real).split(path.posix.sep);
  if (segments.some((segment) => segment.toLowerCase() === PACKAGE_DIRECTORY)) return null;
  return real;
}

/** A failure that is not a refused import, so it reads the same for every definition. */
function plainFailure(context: LoadContext, error: unknown): Failure {
  return { problem: problemOf(context.rootReal, error), refusedIn: null };
}

/** The failure of a refused import: the specifier, then the file that wrote it. */
function importRefused(context: LoadContext, specifier: string, importerReal: string): Failure {
  const details = [specifier, rootRelative(context.rootReal, importerReal)];
  return {
    problem: {
      status: null,
      code: 'import_refused',
      details: details.map((detail) => detail.slice(0, DETAIL_MAX_LENGTH)),
    },
    refusedIn: importerReal,
  };
}

/**
 * The problem a failure gives the definition at `definitionReal`. A problem is always reported
 * against the definition, so the file that made a refused import is named only when it is
 * another file.
 */
function answerFor(failure: Failure, definitionReal: string): ChildProblem {
  const { problem } = failure;
  if (failure.refusedIn !== definitionReal) return problem;
  return { ...problem, details: problem.details.slice(0, 1) };
}

/**
 * Strip and build the file whose real path is `real`, and cache it. `file` names the module: the
 * real path for an imported file, and the path the definition was asked for by, which keeps a
 * definition's identifier and `import.meta` what `node <file>` gives it. A definition another
 * definition imported first carries its real-path identifier instead; that is harmless.
 */
function buildEntry(context: LoadContext, real: string, file: string, source: string): Entry {
  const identifier = pathToFileURL(file).href;
  let entry: Entry;
  try {
    const javascript = stripTypeScriptTypes(source, { mode: 'strip', sourceUrl: identifier });
    const module = new vm.SourceTextModule(javascript, {
      identifier,
      // What `node <file>` gives an ES module: its URL, path and directory.
      initializeImportMeta(meta) {
        meta.url = identifier;
        meta.filename = file;
        meta.dirname = path.dirname(file);
      },
    });
    const built: BuiltEntry = { kind: 'built', real, module, edges: new Map(), failure: null };
    context.byModule.set(module, built);
    entry = built;
  } catch (error) {
    entry = { kind: 'broken', real, failure: plainFailure(context, error) };
  }
  context.cache.set(real, entry);
  return entry;
}

/**
 * Resolve and build everything `entry` reaches, depth first in source order, before anything is
 * linked. A back-edge is skipped, so a cycle is fine. The first failure met (a file that does not
 * strip or build, a refused or unreadable import, a module that already failed) is recorded on
 * every module of the path down to it, and answered.
 */
async function walk(
  context: LoadContext,
  entry: Entry,
  visiting: Set<Entry>,
  visited: Set<Entry>,
): Promise<Failure | null> {
  if (entry.kind === 'broken' || entry.failure !== null) return entry.failure;
  visiting.add(entry);
  for (const { specifier, attributes } of entry.module.moduleRequests) {
    // An import attribute (`with { type: 'json' }`) asks for a module this linker never serves.
    const failure =
      Object.keys(attributes).length > 0
        ? importRefused(context, specifier, entry.real)
        : await walkEdge(context, entry, specifier, visiting, visited);
    if (failure !== null) {
      entry.failure = failure;
      return failure;
    }
  }
  visiting.delete(entry);
  visited.add(entry);
  return null;
}

async function walkEdge(
  context: LoadContext,
  entry: BuiltEntry,
  specifier: string,
  visiting: Set<Entry>,
  visited: Set<Entry>,
): Promise<Failure | null> {
  let edge = entry.edges.get(specifier);
  if (edge === undefined) {
    const resolved = await resolveSpecifier(specifier, entry.real, context.rootReal);
    if (resolved === null) return importRefused(context, specifier, entry.real);
    edge = resolved;
    entry.edges.set(specifier, edge);
  }
  if (edge === DEFINE) return null;
  let target = context.cache.get(edge);
  if (target === undefined) {
    let source: string;
    try {
      source = await readFile(edge, 'utf8');
    } catch {
      return importRefused(context, specifier, entry.real);
    }
    target = buildEntry(context, edge, edge, source);
  }
  if (visiting.has(target) || visited.has(target)) return null;
  return walk(context, target, visiting, visited);
}

/** The linker answers only the edges the walk resolved; it never resolves anything itself. */
function linkerFor(context: LoadContext): vm.ModuleLinker {
  return (specifier, referencingModule) => {
    const edge = context.byModule.get(referencingModule)?.edges.get(specifier);
    if (edge === DEFINE) return defineModule();
    const target = edge === undefined ? undefined : context.cache.get(edge);
    if (target === undefined || target.kind === 'broken') {
      throw new Error(`the loader resolved no module for ${specifier}`);
    }
    return target.module;
  };
}

/**
 * The built modules `entry` reaches that are not linked yet, dependencies first (a back-edge is
 * skipped). The walk resolved every edge, so each target is in the cache.
 */
function unlinkedInLinkOrder(context: LoadContext, entry: BuiltEntry): BuiltEntry[] {
  const order: BuiltEntry[] = [];
  const seen = new Set<BuiltEntry>();
  const visit = (current: BuiltEntry): void => {
    if (seen.has(current) || current.module.status !== 'unlinked') return;
    seen.add(current);
    for (const edge of current.edges.values()) {
      const target = edge === DEFINE ? undefined : context.cache.get(edge);
      if (target?.kind === 'built') visit(target);
    }
    order.push(current);
  };
  visit(entry);
  return order;
}

/**
 * Link `entry`'s graph one module at a time, dependencies first, so the module whose own imports
 * do not link (an import of a missing export) is the one that fails. It keeps the failure, and
 * every definition that reaches it gets the same problem from the walk without linking it again.
 * A failed instantiation leaves its modules unlinked rather than errored, so a healthy module it
 * touched still links for a definition that does not reach the failed one.
 */
async function linkGraph(context: LoadContext, entry: BuiltEntry): Promise<void> {
  const linker = linkerFor(context);
  for (const current of unlinkedInLinkOrder(context, entry)) {
    if (current.module.status !== 'unlinked') continue;
    try {
      await current.module.link(linker);
    } catch (error) {
      const failure = plainFailure(context, error);
      current.failure = failure;
      entry.failure = failure;
      throw new LoadRefusal(failure.problem);
    }
  }
}

/** Evaluate one definition file and answer its default export. */
async function evaluateFile(context: LoadContext, absolute: string): Promise<unknown> {
  const real = await realpath(absolute);
  const entry =
    context.cache.get(real) ??
    buildEntry(context, real, absolute, await readFile(absolute, 'utf8'));
  const failure = await walk(context, entry, new Set(), new Set());
  if (failure !== null) throw new LoadRefusal(answerFor(failure, real));
  if (entry.kind === 'broken') throw new LoadRefusal(answerFor(entry.failure, real));
  const module = entry.module;
  if (module.status === 'unlinked') await linkGraph(context, entry);
  if (module.status === 'errored') {
    throw new LoadRefusal(answerFor(entry.failure ?? plainFailure(context, module.error), real));
  }
  if (module.status !== 'evaluated') {
    try {
      await module.evaluate();
    } catch (error) {
      // Every module the failure left errored keeps its problem, so the next definition that
      // reaches one gets the same code and details without evaluating it again.
      for (const cached of context.byModule.values()) {
        if (cached.failure === null && cached.module.status === 'errored') {
          cached.failure = plainFailure(context, cached.module.error);
        }
      }
      throw error;
    }
  }
  const namespace = module.namespace;
  if (!Object.hasOwn(namespace, 'default')) {
    throw refusal('default_export_missing', 'the file must `export default` its definition');
  }
  const value: unknown = Reflect.get(namespace, 'default');
  return value;
}

/**
 * The text of `instructions: { file }`, resolved beside the definition. The file's real path must
 * stay inside the project, so a link out of it is refused rather than followed.
 */
async function readInstructions(rootReal: string, absolute: string, file: string): Promise<string> {
  const candidate = path.resolve(path.dirname(absolute), file);
  let real: string;
  let text: string;
  try {
    real = await realpath(candidate);
    text = await readFile(real, 'utf8');
  } catch {
    throw refusal('instructions_unreadable', file);
  }
  const relative = path.relative(rootReal, real);
  if (relative === '' || escapes(relative)) {
    throw refusal('instructions_unreadable', `${file} is outside the project`);
  }
  return text;
}

/**
 * The file that declares `tool`: the first evaluated project module, in root-relative path order,
 * other than the agent's own, that exports an equal tool, else the agent's file (an inline tool).
 * `defineAgent()` keeps a checked copy of each tool, so the export is compared by its JSON, which
 * the SDK's one schema writes in one key order.
 * ponytail: a barrel re-export (tools/index.ts) attributes to the first path in sort order;
 * upgrade: prefer the module whose source constructs it.
 */
function declaringFile(
  context: LoadContext,
  agentReal: string,
  tool: define.OpenApiTool | define.PostgresTool | define.CodeTool,
  agentFile: string,
): string {
  const json = JSON.stringify(tool);
  const candidates = [...context.byModule.values()]
    .filter((entry) => entry.real !== agentReal && entry.module.status === 'evaluated')
    .map((entry) => ({ entry, file: rootRelative(context.rootReal, entry.real) }))
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
  for (const { entry, file } of candidates) {
    const namespace = entry.module.namespace;
    const exported = Object.keys(namespace).some((name) => {
      const candidate: unknown = Reflect.get(namespace, name);
      const sameKind = define.isOpenApiTool(tool)
        ? define.isOpenApiTool(candidate)
        : define.isCodeTool(tool)
          ? define.isCodeTool(candidate)
          : define.isPostgresTool(candidate);
      return sameKind && JSON.stringify(candidate) === json;
    });
    if (exported) return file;
  }
  return agentFile;
}

/**
 * The agent's `openapiTool()`, `postgresTool()` and `defineTool()` tools as written, each with its
 * file. A code tool is sent as its declaration: its run file is the tool host's, never read here.
 */
function catalogTools(
  context: LoadContext,
  agentReal: string,
  agent: define.DefinedAgent,
  agentFile: string,
): LoadedToolInput[] {
  const tools: LoadedToolInput[] = [];
  for (const tool of agent.tools ?? []) {
    // The brand is not enumerable, so each copy is exactly the input as written.
    if (define.isOpenApiTool(tool)) {
      const file = declaringFile(context, agentReal, tool, agentFile);
      tools.push({ file, kind: 'openapi', tool: { ...tool } });
    } else if (define.isPostgresTool(tool)) {
      const file = declaringFile(context, agentReal, tool, agentFile);
      tools.push({ file, kind: 'postgres', tool: { ...tool } });
    } else if (define.isCodeTool(tool)) {
      const file = declaringFile(context, agentReal, tool, agentFile);
      tools.push({ file, kind: 'code', tool: { ...tool } });
    }
  }
  return tools;
}

async function loadAgent(
  context: LoadContext,
  message: LoadMessage,
  file: string,
): Promise<LoadedFileInput> {
  const absolute = path.join(message.root, ...file.split('/'));
  try {
    const value = await evaluateFile(context, absolute);
    if (!define.isDefinedAgent(value)) {
      throw refusal('not_a_definition', 'the default export must be made by defineAgent()');
    }
    const source = value.instructions;
    const engine =
      message.defaultEngine === undefined ? {} : { defaultEngine: message.defaultEngine };
    const body = define.toAgentVersionBody(
      value,
      typeof source === 'string'
        ? engine
        : {
            ...engine,
            instructions: await readInstructions(context.rootReal, absolute, source.file),
          },
    );
    const secrets = define
      .toolDefinitionsOf(value)
      .flatMap((tool) => (tool.credential === undefined ? [] : [tool.credential.secret]))
      .concat(
        value.tools?.flatMap((tool) => (define.isCodeTool(tool) ? (tool.secrets ?? []) : [])) ?? [],
      );
    return {
      file,
      kind: 'agent',
      name: value.name,
      body,
      secrets: [...new Set(secrets)],
      tools: catalogTools(context, await realpath(absolute), value, file),
    };
  } catch (error) {
    return { file, kind: 'agent', problem: problemOf(context.rootReal, error) };
  }
}

async function loadSurface(
  context: LoadContext,
  root: string,
  file: string,
): Promise<LoadedFileInput> {
  try {
    const value = await evaluateFile(context, path.join(root, ...file.split('/')));
    if (!define.isDefinedSurface(value)) {
      throw refusal('not_a_definition', 'the default export must be made by defineSurface()');
    }
    // The brand is not enumerable, so the copy is exactly the surface as written.
    return { file, kind: 'surface', surface: { ...value } };
  } catch (error) {
    return { file, kind: 'surface', problem: problemOf(context.rootReal, error) };
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** The parent's message, checked by shape; the parent built it from its own schema. */
function asLoadMessage(message: unknown): LoadMessage | null {
  if (typeof message !== 'object' || message === null) return null;
  const type: unknown = Reflect.get(message, 'type');
  const root: unknown = Reflect.get(message, 'root');
  const agents: unknown = Reflect.get(message, 'agents');
  const surfaces: unknown = Reflect.get(message, 'surfaces');
  const defaultEngine: unknown = Reflect.get(message, 'defaultEngine');
  if (type !== 'load' || typeof root !== 'string') return null;
  if (!isStringArray(agents) || !isStringArray(surfaces)) return null;
  if (defaultEngine === undefined) return { type, root, agents, surfaces };
  if (typeof defaultEngine !== 'string') return null;
  // The parent sent an `EngineIdSchema` value; `toAgentVersionBody` refuses any other again.
  return { type, root, agents, surfaces, defaultEngine: defaultEngine as EngineId };
}

/**
 * Tell the parent which file is about to run, and wait until the message has left this process,
 * so a file that ends the process (`process.exit()`, a top-level await that never settles) is
 * named rather than lost.
 */
function announce(file: string): Promise<void> {
  const message: EvaluatingMessage = { type: 'evaluating', file };
  return new Promise((resolve, reject) => {
    const send = process.send?.bind(process);
    if (send === undefined) {
      reject(new Error('the loader has no parent to answer'));
      return;
    }
    send(message, undefined, {}, (error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
}

async function load(message: LoadMessage): Promise<LoadedMessageInput> {
  const context: LoadContext = {
    rootReal: await realpath(message.root),
    cache: new Map(),
    byModule: new Map(),
  };
  const files: LoadedFileInput[] = [];
  for (const file of message.agents) {
    await announce(file);
    files.push(await loadAgent(context, message, file));
  }
  for (const file of message.surfaces) {
    await announce(file);
    files.push(await loadSurface(context, message.root, file));
  }
  return { type: 'loaded', files };
}

function finish(): void {
  if (process.connected) process.disconnect?.();
}

process.once('message', (message: unknown) => {
  const request = asLoadMessage(message);
  if (request === null) {
    process.exitCode = 2;
    finish();
    return;
  }
  load(request)
    .then((reply) => {
      const send = process.send?.bind(process);
      if (send === undefined) {
        process.exitCode = 2;
        return;
      }
      send(reply, undefined, {}, finish);
    })
    .catch((error: unknown) => {
      process.stderr.write(`aw: the project loader failed: ${messageOf(error)}\n`);
      process.exitCode = 1;
      finish();
    });
});
